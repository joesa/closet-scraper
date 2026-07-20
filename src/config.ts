import type { SearchSeed } from './types.js'

const DEFAULT_KEYWORDS = [
  'custom closets',
  'closet organizers',
  'closet design',
]

const DEFAULT_LOCATIONS = ['Nashville TN']

function splitCsv(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function normalizeMapsPlaceUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return url
  }
}

export interface ScraperConfig {
  proxyGatewayUrl: string
  proxyUrls: string[]
  proxyHealthcheckEnabled: boolean
  proxyHealthcheckTimeoutMs: number
  proxyHealthcheckMinHealthy: number
  // When true, the proxy health check also issues an HTTP request THROUGH each
  // proxy (not just a TCP connect) to confirm it can actually relay traffic.
  proxyHealthcheckHttp: boolean
  proxyHealthcheckUrl: string
  startUrls: string[]
  disableWebhooks: boolean
  maxRequestsPerCrawl: number
  maxRequestRetries: number
  maxResultsPerQuery: number
  maxConcurrency: number
  emailDiscoveryMaxPages: number
  emailDiscoverySecondPassPages: number
  emailDiscoveryTimeoutMs: number
  decisionMakerMaxPages: number
  emailConfidenceThreshold: number
  enableMxCheck: boolean
  enableSmtpCheck: boolean
  smtpTimeoutMs: number
  smtpMinIntervalMs: number
  smtpMaxProbesPerDomain: number
  domainCacheEnabled: boolean
  domainCacheFile: string
  domainCachePatternTtlDays: number
  domainCacheValidationTtlDays: number
  headless: boolean
  mapsKeywords: string[]
  targetLocations: string[]
  pipelineAWebhookUrl: string
  pipelineBWebhookUrl: string
  /** Phone-only Pipeline B leads → dashboard /api/sms-outreach */
  smsOutreachWebhookUrl: string
  webhookBatchSize: number
  webhookAuthHeader: string
  webhookAuthToken: string
  suppressionListFile: string
  suppressionEmails: string[]
  suppressionDomains: string[]
  excludeRoleEmails: boolean
  roleLocalParts: string[]
  unsubscribeBaseUrl: string
  unsubscribeSecret: string
  controlPlaneConfigUrl: string
  controlPlaneToken: string
  controlPlaneTimeoutMs: number
  runStatusUrl: string
  runStatusToken: string
  vercelProtectionBypassSecret: string
  enableOmniFallback: boolean
  enableLumpyMailExport: boolean
  // Vertical/industry parameters used to template outreach copy so the same
  // pipeline can target any service trade (plumbing, towing, landscaping…).
  industryName: string
  industryProblem: string
  // When true, after a run the scraper merges all exports/run-* datasets from a
  // per-city loop into a single deduped exports/combined dataset.
  mergeExports: boolean
}

function loadEnvConfig(): ScraperConfig {
  const proxyUrls = splitCsv(process.env.PROXY_URLS)
  const startUrls = splitCsv(process.env.START_URLS)

  return {
    proxyGatewayUrl:
      process.env.PROXY_GATEWAY_URL ||
      process.env.WEBSHARE_PROXY_GATEWAY_URL ||
      '',
    proxyUrls,
    proxyHealthcheckEnabled: toBool(process.env.PROXY_HEALTHCHECK_ENABLED, true),
    proxyHealthcheckTimeoutMs: toInt(process.env.PROXY_HEALTHCHECK_TIMEOUT_MS, 2500),
    proxyHealthcheckMinHealthy: toInt(process.env.PROXY_HEALTHCHECK_MIN_HEALTHY, 1),
    proxyHealthcheckHttp: toBool(process.env.PROXY_HEALTHCHECK_HTTP, true),
    proxyHealthcheckUrl: process.env.PROXY_HEALTHCHECK_URL || 'http://www.google.com/generate_204',
    startUrls,
    disableWebhooks: process.env.DISABLE_WEBHOOKS === 'true',
    maxRequestsPerCrawl: toInt(process.env.MAX_REQUESTS_PER_CRAWL, 500),
    maxRequestRetries: toInt(process.env.MAX_REQUEST_RETRIES, 3),
    maxResultsPerQuery: toInt(process.env.MAX_RESULTS_PER_QUERY, 120),
    maxConcurrency: toInt(process.env.MAX_CONCURRENCY, 8),
    emailDiscoveryMaxPages: toInt(process.env.EMAIL_DISCOVERY_MAX_PAGES, 3),
    emailDiscoverySecondPassPages: toInt(process.env.EMAIL_DISCOVERY_SECOND_PASS_PAGES, 2),
    emailDiscoveryTimeoutMs: toInt(process.env.EMAIL_DISCOVERY_TIMEOUT_MS, 15000),
    decisionMakerMaxPages: toInt(process.env.DECISION_MAKER_MAX_PAGES, 6),
    emailConfidenceThreshold: toInt(process.env.EMAIL_CONFIDENCE_THRESHOLD, 75),
    enableMxCheck: toBool(process.env.ENABLE_MX_CHECK, false),
    enableSmtpCheck: toBool(process.env.ENABLE_SMTP_CHECK, false),
    smtpTimeoutMs: toInt(process.env.SMTP_TIMEOUT_MS, 8000),
    smtpMinIntervalMs: toInt(process.env.SMTP_MIN_INTERVAL_MS, 1500),
    smtpMaxProbesPerDomain: toInt(process.env.SMTP_MAX_PROBES_PER_DOMAIN, 3),
    domainCacheEnabled: toBool(process.env.DOMAIN_CACHE_ENABLED, true),
    domainCacheFile: process.env.DOMAIN_CACHE_FILE || 'storage/domain-email-cache.json',
    domainCachePatternTtlDays: toInt(process.env.DOMAIN_CACHE_PATTERN_TTL_DAYS, 90),
    domainCacheValidationTtlDays: toInt(process.env.DOMAIN_CACHE_VALIDATION_TTL_DAYS, 14),
    headless: process.env.HEADLESS !== 'false',
    mapsKeywords: splitCsv(process.env.MAPS_KEYWORDS).length
      ? splitCsv(process.env.MAPS_KEYWORDS)
      : DEFAULT_KEYWORDS,
    targetLocations: splitCsv(process.env.TARGET_LOCATIONS).length
      ? splitCsv(process.env.TARGET_LOCATIONS)
      : DEFAULT_LOCATIONS,
    pipelineAWebhookUrl: process.env.INSTANTLY_PIPELINE_A_WEBHOOK_URL || '',
    pipelineBWebhookUrl: process.env.INSTANTLY_PIPELINE_B_WEBHOOK_URL || '',
    smsOutreachWebhookUrl: process.env.SMS_OUTREACH_WEBHOOK_URL || '',
    webhookBatchSize: toInt(process.env.WEBHOOK_BATCH_SIZE, 50),
    webhookAuthHeader: process.env.WEBHOOK_AUTH_HEADER || 'Authorization',
    webhookAuthToken: process.env.WEBHOOK_AUTH_TOKEN || '',
    suppressionListFile: process.env.SUPPRESSION_LIST_FILE || '',
    suppressionEmails: splitCsv(process.env.SUPPRESSION_EMAILS || ''),
    suppressionDomains: splitCsv(process.env.SUPPRESSION_DOMAINS || ''),
    excludeRoleEmails: process.env.EXCLUDE_ROLE_EMAILS !== 'false',
    roleLocalParts: splitCsv(process.env.ROLE_LOCAL_PARTS || ''),
    unsubscribeBaseUrl: process.env.UNSUBSCRIBE_BASE_URL || '',
    unsubscribeSecret: process.env.UNSUBSCRIBE_SECRET || 'change-me',
    controlPlaneConfigUrl: process.env.SCRAPER_CONTROL_PLANE_CONFIG_URL || '',
    controlPlaneToken: process.env.SCRAPER_CONTROL_PLANE_TOKEN || '',
    controlPlaneTimeoutMs: toInt(process.env.SCRAPER_CONTROL_PLANE_TIMEOUT_MS, 8000),
    runStatusUrl: process.env.SCRAPER_RUN_STATUS_URL || '',
    runStatusToken: process.env.SCRAPER_RUN_STATUS_TOKEN || '',
    vercelProtectionBypassSecret:
      process.env.SCRAPER_VERCEL_BYPASS_SECRET ||
      process.env.VERCEL_AUTOMATION_BYPASS_SECRET ||
      '',
    enableOmniFallback: toBool(process.env.ENABLE_OMNI_FALLBACK, true),
    enableLumpyMailExport: toBool(process.env.ENABLE_LUMPY_MAIL_EXPORT, true),
    industryName: process.env.INDUSTRY_NAME || 'custom closet & storage',
    industryProblem:
      process.env.INDUSTRY_PROBLEM ||
      'relying on a standard contact form to capture incoming customer inquiries',
    mergeExports: toBool(process.env.SCRAPER_MERGE_EXPORTS, false),
  }
}

function safeRemoteArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value
    .map((v) => String(v || '').trim())
    .filter(Boolean)
}

function safeRemoteInt(value: unknown): number | null {
  const n = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) ? n : null
}

function safeRemoteBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  }
  return null
}

function mergeRemoteConfig(base: ScraperConfig, remote: Record<string, unknown>): ScraperConfig {
  const next: ScraperConfig = { ...base }

  if ('proxyGatewayUrl' in remote && typeof remote.proxyGatewayUrl === 'string') {
    next.proxyGatewayUrl = remote.proxyGatewayUrl.trim()
  }
  if ('proxyUrls' in remote) {
    next.proxyUrls = safeRemoteArray(remote.proxyUrls) ?? []
  }
  if ('proxyHealthcheckEnabled' in remote) {
    next.proxyHealthcheckEnabled =
      safeRemoteBool(remote.proxyHealthcheckEnabled) ?? next.proxyHealthcheckEnabled
  }
  if ('proxyHealthcheckTimeoutMs' in remote) {
    const value = safeRemoteInt(remote.proxyHealthcheckTimeoutMs)
    if (value !== null) next.proxyHealthcheckTimeoutMs = Math.max(250, value)
  }
  if ('proxyHealthcheckMinHealthy' in remote) {
    const value = safeRemoteInt(remote.proxyHealthcheckMinHealthy)
    if (value !== null) next.proxyHealthcheckMinHealthy = Math.max(1, value)
  }
  if ('startUrls' in remote) {
    next.startUrls = safeRemoteArray(remote.startUrls) ?? []
  }
  if ('disableWebhooks' in remote) {
    next.disableWebhooks = safeRemoteBool(remote.disableWebhooks) ?? next.disableWebhooks
  }
  if ('mapsKeywords' in remote) {
    const keywords = safeRemoteArray(remote.mapsKeywords)
    if (keywords && keywords.length) next.mapsKeywords = keywords
  }
  if ('targetLocations' in remote) {
    const locations = safeRemoteArray(remote.targetLocations)
    if (locations && locations.length) next.targetLocations = locations
  }
  if ('headless' in remote) {
    next.headless = safeRemoteBool(remote.headless) ?? next.headless
  }
  if ('maxConcurrency' in remote) {
    const value = safeRemoteInt(remote.maxConcurrency)
    if (value !== null) next.maxConcurrency = value
  }
  if ('maxResultsPerQuery' in remote) {
    const value = safeRemoteInt(remote.maxResultsPerQuery)
    if (value !== null) next.maxResultsPerQuery = value
  }
  if ('maxRequestsPerCrawl' in remote) {
    const value = safeRemoteInt(remote.maxRequestsPerCrawl)
    if (value !== null) next.maxRequestsPerCrawl = value
  }
  if ('webhookBatchSize' in remote) {
    const value = safeRemoteInt(remote.webhookBatchSize)
    if (value !== null) next.webhookBatchSize = value
  }
  if ('pipelineAWebhookUrl' in remote && typeof remote.pipelineAWebhookUrl === 'string') {
    next.pipelineAWebhookUrl = remote.pipelineAWebhookUrl.trim()
  }
  if ('pipelineBWebhookUrl' in remote && typeof remote.pipelineBWebhookUrl === 'string') {
    next.pipelineBWebhookUrl = remote.pipelineBWebhookUrl.trim()
  }
  if ('smsOutreachWebhookUrl' in remote && typeof remote.smsOutreachWebhookUrl === 'string') {
    next.smsOutreachWebhookUrl = remote.smsOutreachWebhookUrl.trim()
  }
  if ('webhookAuthHeader' in remote && typeof remote.webhookAuthHeader === 'string') {
    next.webhookAuthHeader = remote.webhookAuthHeader.trim() || next.webhookAuthHeader
  }
  if ('enableOmniFallback' in remote) {
    next.enableOmniFallback = safeRemoteBool(remote.enableOmniFallback) ?? next.enableOmniFallback
  }
  if ('enableLumpyMailExport' in remote) {
    next.enableLumpyMailExport = safeRemoteBool(remote.enableLumpyMailExport) ?? next.enableLumpyMailExport
  }

  return next
}

export async function loadConfig(): Promise<ScraperConfig> {
  const envConfig = loadEnvConfig()

  if (!envConfig.controlPlaneConfigUrl) return envConfig
  if (!envConfig.controlPlaneToken) return envConfig

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), envConfig.controlPlaneTimeoutMs)

    const response = await fetch(envConfig.controlPlaneConfigUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${envConfig.controlPlaneToken}`,
        ...(envConfig.vercelProtectionBypassSecret
          ? {
              'x-vercel-protection-bypass': envConfig.vercelProtectionBypassSecret,
              'x-vercel-set-bypass-cookie': 'true',
            }
          : {}),
      },
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!response.ok) return envConfig

    const body = (await response.json()) as { config?: Record<string, unknown> }
    if (!body || typeof body !== 'object' || !body.config || typeof body.config !== 'object') {
      return envConfig
    }

    return mergeRemoteConfig(envConfig, body.config)
  } catch {
    return envConfig
  }
}

export function buildSearchSeeds(config: ScraperConfig): SearchSeed[] {
  const seeds: SearchSeed[] = []

  for (const keyword of config.mapsKeywords) {
    for (const location of config.targetLocations) {
      const query = `${keyword} ${location}`.trim()
      seeds.push({
        keyword,
        location,
        query,
        searchUrl: normalizeMapsPlaceUrl(
          `https://www.google.com/maps/search/${encodeURIComponent(query)}`
        ),
      })
    }
  }

  return seeds
}
