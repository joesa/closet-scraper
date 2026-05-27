import 'dotenv/config'

import net from 'node:net'

import { Browser, ImpitHttpClient } from '@crawlee/impit-client'
import { PlaywrightCrawler, ProxyConfiguration, log } from 'crawlee'

import { loadComplianceResources } from './compliance.js'
import { buildSearchSeeds, loadConfig } from './config.js'
import type { ScraperConfig } from './config.js'
import { configureDomainCache, flushDomainCache, loadDomainCache } from './domain-cache.js'
import { nowRunId, writeRunArtifacts } from './exporters.js'
import { getAllLeads, getLeadStats, getLeadsByPipeline } from './state.js'
import { buildRouter } from './routes.js'
import { dispatchToWebhook } from './webhooks.js'
import { postRunStatus } from './run-status.js'

function seedFromStartUrl(startUrl: string) {
    return {
        keyword: 'manual',
        location: 'manual',
        query: startUrl,
        searchUrl: startUrl,
    }
}

function extractErrorCode(value: unknown): string | null {
    if (value && typeof value === 'object' && 'code' in value) {
        const code = (value as { code?: unknown }).code
        if (typeof code === 'string' && code.trim()) return code
    }

    const message = value instanceof Error ? value.message : String(value)
    const match = message.match(/\bERR_[A-Z0-9_]+\b/)
    return match?.[0] ?? null
}

function telemetryErrorPayload(value: unknown): Record<string, unknown> {
    const errorClass = value instanceof Error ? value.name : typeof value
    const errorMessage = value instanceof Error ? value.message : String(value)
    const errorCode = extractErrorCode(value)

    return {
        error: errorMessage,
        errorClass,
        errorCode,
    }
}

function normalizeProxyUrl(url: string): string | null {
    const value = url.trim()
    if (!value) return null

    try {
        const parsed = new URL(value)
        if (!['http:', 'https:'].includes(parsed.protocol)) return null
        if (!parsed.hostname) return null
        return parsed.toString()
    } catch {
        return null
    }
}

function resolveConfiguredProxyUrls(config: ScraperConfig): string[] {
    const unique = new Set<string>()

    const gateway = normalizeProxyUrl(config.proxyGatewayUrl)
    if (gateway) {
        unique.add(gateway)
        return Array.from(unique)
    }

    for (const candidate of config.proxyUrls) {
        const normalized = normalizeProxyUrl(candidate)
        if (normalized) unique.add(normalized)
    }

    return Array.from(unique)
}

async function tcpConnects(proxyUrl: string, timeoutMs: number): Promise<boolean> {
    try {
        const parsed = new URL(proxyUrl)
        const host = parsed.hostname
        const port = parsed.port
            ? Number.parseInt(parsed.port, 10)
            : parsed.protocol === 'https:'
                ? 443
                : 80

        if (!Number.isFinite(port) || port <= 0) return false

        await new Promise<void>((resolve, reject) => {
            const socket = net.connect({ host, port, timeout: timeoutMs })

            socket.once('connect', () => {
                socket.end()
                resolve()
            })
            socket.once('timeout', () => {
                socket.destroy()
                reject(new Error('timeout'))
            })
            socket.once('error', (error) => {
                socket.destroy()
                reject(error)
            })
        })

        return true
    } catch {
        return false
    }
}

async function filterHealthyProxyUrls(
    proxyUrls: string[],
    timeoutMs: number
): Promise<{ healthy: string[]; unhealthy: string[] }> {
    if (proxyUrls.length === 0) return { healthy: [], unhealthy: [] }

    const checks = await Promise.all(
        proxyUrls.map(async (proxyUrl) => ({
            proxyUrl,
            ok: await tcpConnects(proxyUrl, timeoutMs),
        }))
    )

    return {
        healthy: checks.filter((c) => c.ok).map((c) => c.proxyUrl),
        unhealthy: checks.filter((c) => !c.ok).map((c) => c.proxyUrl),
    }
}

async function main() {
    const preassignedRunId = (process.env.SCRAPER_TRIGGER_RUN_ID || '').trim()
    const runId = preassignedRunId || nowRunId()
    const config = await loadConfig()

    try {
        configureDomainCache({
            enabled: config.domainCacheEnabled,
            filePath: config.domainCacheFile,
        })
        await loadDomainCache()

        const compliance = await loadComplianceResources(config)
        const seeds = config.startUrls.length
            ? config.startUrls.map(seedFromStartUrl)
            : buildSearchSeeds(config)

        if (seeds.length === 0) {
            throw new Error('No search seeds were generated. Set MAPS_KEYWORDS and TARGET_LOCATIONS.')
        }

        const configuredProxyUrls = resolveConfiguredProxyUrls(config)
        const usingGatewayProxy = Boolean(normalizeProxyUrl(config.proxyGatewayUrl))

        let healthyProxyUrls = configuredProxyUrls
        if (config.proxyHealthcheckEnabled && configuredProxyUrls.length > 0) {
            const { healthy, unhealthy } = await filterHealthyProxyUrls(
                configuredProxyUrls,
                config.proxyHealthcheckTimeoutMs
            )
            healthyProxyUrls = healthy

            if (unhealthy.length > 0) {
                log.warning('Excluded unhealthy proxies before crawl', {
                    unhealthyCount: unhealthy.length,
                    healthyCount: healthy.length,
                })
            }

            if (healthyProxyUrls.length < config.proxyHealthcheckMinHealthy) {
                throw new Error(
                    `Proxy health check failed: ${healthyProxyUrls.length} healthy proxies; requires at least ${config.proxyHealthcheckMinHealthy}`
                )
            }
        }

        log.info('Starting closet-scraper run', {
            queryCount: seeds.length,
            proxyMode: usingGatewayProxy ? 'gateway' : 'list',
            proxyCount: healthyProxyUrls.length,
            configuredProxyCount: configuredProxyUrls.length,
            maxResultsPerQuery: config.maxResultsPerQuery,
            usingStartUrls: config.startUrls.length > 0,
            webhooksDisabled: config.disableWebhooks,
        })

        await postRunStatus(config, 'started', runId, {
            queryCount: seeds.length,
            proxyMode: usingGatewayProxy ? 'gateway' : 'list',
            proxyCount: healthyProxyUrls.length,
            configuredProxyCount: configuredProxyUrls.length,
            proxyHealthcheckEnabled: config.proxyHealthcheckEnabled,
            maxResultsPerQuery: config.maxResultsPerQuery,
            usingStartUrls: config.startUrls.length > 0,
            webhooksDisabled: config.disableWebhooks,
            targetLocations: config.targetLocations,
        })

        const startRequests = seeds.map((seed) => ({
            url: seed.searchUrl,
            label: 'MAPS_SEARCH',
            userData: { seed },
        }))

        const crawler = new PlaywrightCrawler({
            proxyConfiguration: healthyProxyUrls.length
                ? new ProxyConfiguration({ proxyUrls: healthyProxyUrls })
                : undefined,
            httpClient: new ImpitHttpClient({ browser: Browser.Chrome }),
            requestHandler: buildRouter(config),
            maxRequestsPerCrawl: config.maxRequestsPerCrawl,
            maxConcurrency: config.maxConcurrency,
            requestHandlerTimeoutSecs: 90,
            launchContext: {
                launchOptions: {
                    headless: config.headless,
                },
            },
        })

        await crawler.run(startRequests)

        const allLeads = getAllLeads()
        const stats = getLeadStats()
        const artifacts = await writeRunArtifacts({
            runId,
            seeds,
            leads: allLeads,
            stats,
            compliance,
        })

        const pipelineALeads = getLeadsByPipeline('PIPELINE_A')
        const pipelineBLeads = getLeadsByPipeline('PIPELINE_B')

        const [pipelineAResult, pipelineBResult] = config.disableWebhooks
            ? [
                    {
                        pipeline: 'PIPELINE_A',
                        urlConfigured: false,
                        attemptedBatches: 0,
                        successfulBatches: 0,
                        failedBatches: 0,
                    },
                    {
                        pipeline: 'PIPELINE_B',
                        urlConfigured: false,
                        attemptedBatches: 0,
                        successfulBatches: 0,
                        failedBatches: 0,
                    },
                ]
            : await Promise.all([
                    dispatchToWebhook('PIPELINE_A', config.pipelineAWebhookUrl, pipelineALeads, {
                        batchSize: config.webhookBatchSize,
                        authHeader: config.webhookAuthHeader,
                        authToken: config.webhookAuthToken,
                        runId: artifacts.runId,
                    }),
                    dispatchToWebhook('PIPELINE_B', config.pipelineBWebhookUrl, pipelineBLeads, {
                        batchSize: config.webhookBatchSize,
                        authHeader: config.webhookAuthHeader,
                        authToken: config.webhookAuthToken,
                        runId: artifacts.runId,
                    }),
                ])

        log.info('Scrape run finished', {
            stats,
            artifacts,
            webhooks: [pipelineAResult, pipelineBResult],
        })

        await postRunStatus(config, 'completed', artifacts.runId, {
            stats,
            webhooks: [pipelineAResult, pipelineBResult],
            artifacts,
            targetLocations: config.targetLocations,
            selectedCities: config.targetLocations,
        })

        await flushDomainCache()
    } catch (error) {
        try {
            await postRunStatus(config, 'failed', runId, telemetryErrorPayload(error))
        } catch {
            // Ignore secondary telemetry errors and rethrow original failure.
        }
        await flushDomainCache()
        throw error
    }
}

await main()
