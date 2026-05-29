import { createPlaywrightRouter } from 'crawlee'

import type { ScraperConfig } from './config.js'
import { classifyLeadWebsite, guessAndVerifyFallbackEmails } from './enrichment.js'
import { upsertLead } from './state.js'
import type { QualifiedLead, RawLead, SearchSeed } from './types.js'

type RouteUserData = {
    seed?: SearchSeed
    rawLead?: RawLead
}

function toAbsoluteGoogleMapsUrl(input: string | null): string | null {
    if (!input) return null
    try {
        return new URL(input, 'https://www.google.com').toString()
    } catch {
        return null
    }
}

async function scrollMapsResults(page: any): Promise<void> {
    await page.waitForTimeout(1500)

    for (let i = 0; i < 40; i += 1) {
        const endReached = await page.evaluate(() => {
            const feed = document.querySelector('div[role="feed"]') as HTMLElement | null
            if (!feed) return false

            const endNode = Array.from(document.querySelectorAll('span, div')).find((el) => {
                const text = el.textContent?.toLowerCase() || ''
                return text.includes('you\'ve reached the end of the list') || text.includes('end of results')
            })
            if (endNode) return true

            feed.scrollBy(0, 900)
            return false
        })

        if (endReached) return
        await page.waitForTimeout(500)
    }
}

async function extractPlaceUrls(page: any, maxResults: number): Promise<string[]> {
    return page.evaluate((max: number) => {
        const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[]
        const urls: string[] = []
        const seen = new Set<string>()

        for (const anchor of anchors) {
            const href = anchor.getAttribute('href') || ''
            const isPlace = href.includes('/maps/place/') || href.includes('/maps?cid=')
            if (!isPlace) continue

            const abs = new URL(href, 'https://www.google.com').toString()
            if (seen.has(abs)) continue
            seen.add(abs)
            urls.push(abs)
            if (urls.length >= max) break
        }

        return urls
    }, maxResults)
}

function parsePhoneFromAriaLabel(label: string | null): string | null {
    if (!label) return null
    const match = label.match(/phone:\s*(.*)$/i)
    if (match?.[1]) return match[1].trim()
    return null
}

function parseRatingValue(text: string | null): number | null {
    if (!text) return null
    const match = text.match(/(\d+(?:\.\d+)?)/)
    if (!match?.[1]) return null
    const n = Number.parseFloat(match[1])
    return Number.isFinite(n) ? n : null
}

function parseReviewCount(text: string | null): number | null {
    if (!text) return null
    const withLabel = text.match(/([\d,]+)\s+reviews?/i)
    const fallback = text.match(/\((\d[\d,]*)\)/)
    const raw = withLabel?.[1] || fallback?.[1]
    if (!raw) return null
    const n = Number.parseInt(raw.replace(/,/g, ''), 10)
    return Number.isFinite(n) ? n : null
}

function normalizeWebsiteFromMaps(input: string | null): string | null {
    if (!input) return null
    try {
        const parsed = new URL(input)
        const isGoogleRedirect =
            parsed.hostname.endsWith('google.com') &&
            parsed.pathname === '/url'
        if (isGoogleRedirect) {
            const q = parsed.searchParams.get('q')
            if (q) return q
        }
        return parsed.toString()
    } catch {
        return input
    }
}

export function buildRouter(config: ScraperConfig) {
    const router = createPlaywrightRouter()

    router.addDefaultHandler(async ({ request, log }) => {
        log.warning('Unhandled request label', {
            label: request.label,
            url: request.url,
        })
    })

    router.addHandler('MAPS_SEARCH', async ({ request, page, addRequests, log }) => {
        const seed = (request.userData as RouteUserData).seed
        if (!seed) {
            log.warning('Search request missing seed metadata', { url: request.url })
            return
        }

        await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
        await page.waitForTimeout(1500)
        await scrollMapsResults(page)

        const placeUrls = await extractPlaceUrls(page, config.maxResultsPerQuery)

        log.info('Discovered places from Google Maps query', {
            query: seed.query,
            count: placeUrls.length,
        })

        await addRequests(
            placeUrls.map((url) => ({
                url,
                label: 'MAPS_PLACE',
                userData: { seed },
            }))
        )
    })

    router.addHandler('MAPS_PLACE', async ({ request, page, log, pushData, addRequests }) => {
        const seed = (request.userData as RouteUserData).seed
        if (!seed) {
            log.warning('Place request missing seed metadata', { url: request.url })
            return
        }

        await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
        await page.waitForTimeout(1200)

        const scraped = await page.evaluate(() => {
            const headingCandidates = Array.from(document.querySelectorAll('h1')) as HTMLElement[]
            const titleEl = headingCandidates.find((el) => {
                const txt = el.textContent?.trim() || ''
                return txt.length > 0 && txt.length < 140
            }) || null

            const websiteAnchor =
                (document.querySelector('a[data-item-id="authority"]') as HTMLAnchorElement | null) ||
                (Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[]).find((a) => {
                    const label = (a.getAttribute('aria-label') || '').toLowerCase()
                    const text = (a.textContent || '').toLowerCase()
                    const href = a.href || ''
                    if (!/^https?:\/\//i.test(href)) return false
                    // Accept only explicit website actions, not arbitrary external links
                    // (e.g. support/google policy links in the place panel).
                    return label.includes('website') || text === 'website'
                }) ||
                null

            const phoneButton =
                (document.querySelector('button[data-item-id^="phone:tel:"]') as HTMLElement | null) ||
                (document.querySelector('button[aria-label^="Phone:"]') as HTMLElement | null) ||
                (Array.from(document.querySelectorAll('button[aria-label], a[aria-label]')) as HTMLElement[]).find((el) => {
                    const label = (el.getAttribute('aria-label') || '').toLowerCase()
                    return label.startsWith('phone:') || label.includes('copy phone number')
                }) ||
                null

            const addressButton =
                (document.querySelector('button[data-item-id="address"]') as HTMLElement | null) ||
                (document.querySelector('button[aria-label^="Address:"]') as HTMLElement | null) ||
                (Array.from(document.querySelectorAll('button[aria-label], a[aria-label]')) as HTMLElement[]).find((el) => {
                    const label = (el.getAttribute('aria-label') || '').toLowerCase()
                    return label.startsWith('address:')
                }) ||
                null

            const ratingNode =
                (Array.from(document.querySelectorAll('[aria-label]')) as HTMLElement[]).find((el) => {
                    const label = (el.getAttribute('aria-label') || '').toLowerCase()
                    return /\b\d(\.\d)?\s*stars?\b/.test(label)
                }) ||
                null

            const reviewNode =
                (Array.from(document.querySelectorAll('[aria-label]')) as HTMLElement[]).find((el) => {
                    const label = (el.getAttribute('aria-label') || '').toLowerCase()
                    return /\breviews?\b/.test(label)
                }) ||
                null

            const ratingTextFromAria = ratingNode?.getAttribute('aria-label') || null
            const ratingTextFromText = ratingNode?.textContent?.trim() || null
            const reviewTextFromAria = reviewNode?.getAttribute('aria-label') || null
            const reviewTextFromText = reviewNode?.textContent?.trim() || null

            return {
                businessName: titleEl?.textContent?.trim() || null,
                websiteUrl: websiteAnchor?.href || null,
                phoneAriaLabel: phoneButton?.getAttribute('aria-label') || null,
                phoneText: phoneButton?.textContent?.trim() || null,
                address: addressButton?.textContent?.trim() || null,
                ratingText: ratingTextFromText || ratingTextFromAria,
                reviewText: reviewTextFromText || reviewTextFromAria,
            }
        })

        const phoneNumber =
            parsePhoneFromAriaLabel(scraped.phoneAriaLabel) ||
            scraped.phoneText ||
            null

        const normalizedPlaceUrl = toAbsoluteGoogleMapsUrl(request.loadedUrl || request.url)
        if (!normalizedPlaceUrl) {
            log.warning('Failed to normalize place URL', { raw: request.loadedUrl || request.url })
            return
        }

        const rawLead: RawLead = {
            sourceQuery: seed.query,
            sourceKeyword: seed.keyword,
            sourceLocation: seed.location,
            mapsPlaceUrl: normalizedPlaceUrl,
            businessName: scraped.businessName,
            websiteUrl: normalizeWebsiteFromMaps(scraped.websiteUrl),
            phoneNumber,
            address: scraped.address,
            ratingText: scraped.ratingText,
            ratingValue: parseRatingValue(scraped.ratingText),
            reviewCount: parseReviewCount(scraped.reviewText || scraped.ratingText),
        }

        if (!rawLead.websiteUrl && config.enableOmniFallback) {
            if (!rawLead.businessName) {
                log.warning('Lead missing website and businessName, skipping fallback', { url: request.url })
            } else {
                log.info('Lead missing website, engaging Omni-Channel fallback', { business: rawLead.businessName })
                
                // Construct Google Search URL for social profiles
                const sq = encodeURIComponent(`site:facebook.com OR site:instagram.com "${rawLead.businessName}" "${seed.location}"`)
                const searchUrl = `https://www.google.com/search?q=${sq}`
                
                await addRequests([{
                    url: searchUrl,
                    label: 'SOCIAL_SERP_SEARCH',
                    userData: { seed, rawLead }
                }])
                return // Stop processing this lead here, let the fallback handle it
            }
        }

        const enrichment = await classifyLeadWebsite(rawLead.websiteUrl, {
            maxSubPages: config.emailDiscoveryMaxPages,
            secondPassPages: config.emailDiscoverySecondPassPages,
            requestTimeoutMs: config.emailDiscoveryTimeoutMs,
            decisionMakerMaxPages: config.decisionMakerMaxPages,
            emailConfidenceThreshold: config.emailConfidenceThreshold,
            enableMxCheck: config.enableMxCheck,
            enableSmtpCheck: config.enableSmtpCheck,
            smtpTimeoutMs: config.smtpTimeoutMs,
            smtpMinIntervalMs: config.smtpMinIntervalMs,
            smtpMaxProbesPerDomain: config.smtpMaxProbesPerDomain,
            domainCachePatternTtlDays: config.domainCachePatternTtlDays,
            domainCacheValidationTtlDays: config.domainCacheValidationTtlDays,
        })
        const qualifiedLead: QualifiedLead = {
            ...rawLead,
            enrichment,
        }

        upsertLead(qualifiedLead)
        await pushData(qualifiedLead)

        log.info('Qualified lead', {
            business: qualifiedLead.businessName,
            pipeline: qualifiedLead.enrichment.pipeline,
            outreachRank: qualifiedLead.enrichment.outreachRank,
            reason: qualifiedLead.enrichment.reason,
            primaryEmail: qualifiedLead.enrichment.primaryEmail,
            confidence: `${qualifiedLead.enrichment.confidenceLabel}:${qualifiedLead.enrichment.confidenceScore}`,
        })
    })

    router.addHandler('SOCIAL_SERP_SEARCH', async ({ request, page, log, addRequests }) => {
        const userData = request.userData as RouteUserData
        if (!userData.rawLead) return

        try {
            await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
            await page.waitForTimeout(1000)
            
            // Check for CAPTCHA
            const isCaptcha = await page.evaluate(() => !!document.querySelector('form[action="/sorry/index"]'))
            if (isCaptcha) {
                log.warning('Google Search CAPTCHA hit, silently failing SERP hunt', { business: userData.rawLead.businessName })
                // Let it fall through to SMS / Lumpy Mail by classifying with null website
                await addRequests([{
                    url: request.url, // arbitrary URL just to trigger the fallback processing
                    label: 'FINALIZE_FALLBACK',
                    userData
                }])
                return
            }

            const socialUrl = await page.evaluate(() => {
                const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[]
                for (const a of anchors) {
                    const href = a.href
                    if (href.includes('facebook.com') || href.includes('instagram.com')) {
                        // ignore google tracking params
                        try {
                            const u = new URL(href)
                            if (u.hostname.endsWith('google.com') && u.pathname === '/url') {
                                const q = u.searchParams.get('q')
                                if (q && (q.includes('facebook.com') || q.includes('instagram.com'))) return q
                            }
                            return href
                        } catch { }
                    }
                }
                return null
            })

            if (socialUrl) {
                log.info('Found social profile', { url: socialUrl })
                await addRequests([{
                    url: socialUrl,
                    label: 'SOCIAL_PROFILE_SCRAPE',
                    userData
                }])
            } else {
                log.info('No social profile found in SERP', { business: userData.rawLead.businessName })
                await addRequests([{
                    url: request.url,
                    label: 'FINALIZE_FALLBACK',
                    userData
                }])
            }
        } catch (err) {
            log.warning('SOCIAL_SERP_SEARCH failed', { err: String(err) })
            await addRequests([{
                url: request.url,
                label: 'FINALIZE_FALLBACK',
                userData
            }])
        }
    })

    router.addHandler('SOCIAL_PROFILE_SCRAPE', async ({ request, page, log, addRequests, pushData }) => {
        const userData = request.userData as RouteUserData
        if (!userData.rawLead) return

        try {
            let targetUrl = request.url
            if (targetUrl.includes('facebook.com') && !targetUrl.includes('about')) {
                // Try to bypass timeline to contact info
                const u = new URL(targetUrl)
                targetUrl = `${u.origin}${u.pathname.replace(/\/$/, '')}/about_contact_and_basic_info`
            }

            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
            await page.waitForTimeout(2000)

            const text = await page.evaluate(() => document.body.innerText)
            
            // Basic email regex extraction
            const emailMatch = text.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/)
            const extractedEmail = emailMatch ? emailMatch[1].trim().toLowerCase() : null

            userData.rawLead.websiteUrl = request.url // Record the social profile as their website

            if (extractedEmail) {
                log.info('Extracted email from social profile', { email: extractedEmail })
                // Construct fake enrichment to push to Pipeline A
                const qualifiedLead: QualifiedLead = {
                    ...userData.rawLead,
                    enrichment: {
                        pipeline: 'PIPELINE_A' as const,
                        reason: 'social_profile_extraction' as const,
                        contactPageUrl: targetUrl,
                        primaryEmail: extractedEmail,
                        decisionMakerName: null,
                        decisionMakerTitle: null,
                        decisionMakerEmail: extractedEmail,
                        decisionMakerEmailType: 'unknown',
                        decisionMakerEmailConfidence: 80,
                        decisionMakerEmailSource: 'social',
                        discoveredEmails: [extractedEmail],
                        pagesScanned: [targetUrl],
                        confidenceScore: 80,
                        confidenceLabel: 'medium' as const,
                        outreachRank: 'A2' as const,
                    }
                }
                upsertLead(qualifiedLead)
                await pushData(qualifiedLead)
            } else {
                log.info('No email found on social profile, trying SMTP guess', { business: userData.rawLead.businessName })
                await addRequests([{
                    url: targetUrl,
                    label: 'FINALIZE_FALLBACK',
                    userData
                }])
            }
        } catch (err) {
            log.warning('SOCIAL_PROFILE_SCRAPE failed', { err: String(err) })
            await addRequests([{
                url: request.url,
                label: 'FINALIZE_FALLBACK',
                userData
            }])
        }
    })

    router.addHandler('FINALIZE_FALLBACK', async ({ request, pushData, log }) => {
        const userData = request.userData as RouteUserData
        if (!userData.rawLead) return
        
        let foundEmail: string | null = null
        
        const fallback = await guessAndVerifyFallbackEmails(userData.rawLead.businessName, {
            enableMxCheck: config.enableMxCheck,
            enableSmtpCheck: config.enableSmtpCheck,
            smtpTimeoutMs: config.smtpTimeoutMs,
            smtpMinIntervalMs: config.smtpMinIntervalMs,
            smtpMaxProbesPerDomain: config.smtpMaxProbesPerDomain,
            cacheValidationTtlDays: config.domainCacheValidationTtlDays,
        })

        if (fallback) {
            log.info('Recovered email via SMTP fallback', { email: fallback.email })
            foundEmail = fallback.email
        }

        const enrichment = foundEmail ? {
            pipeline: 'PIPELINE_A' as const,
            reason: 'smtp_domain_guessing' as const,
            contactPageUrl: null,
            primaryEmail: foundEmail,
            decisionMakerName: null,
            decisionMakerTitle: null,
            decisionMakerEmail: foundEmail,
            decisionMakerEmailType: 'unknown' as const,
            decisionMakerEmailConfidence: fallback?.confidence || 0,
            decisionMakerEmailSource: 'smtp_guess' as const,
            discoveredEmails: [foundEmail],
            pagesScanned: [],
            confidenceScore: fallback?.confidence || 0,
            confidenceLabel: 'medium' as const,
            outreachRank: 'A2' as const,
        } : {
            pipeline: 'PIPELINE_B' as const,
            reason: 'missing_website' as const,
            contactPageUrl: null,
            primaryEmail: null,
            decisionMakerName: null,
            decisionMakerTitle: null,
            decisionMakerEmail: null,
            decisionMakerEmailType: 'unknown' as const,
            decisionMakerEmailConfidence: 0,
            decisionMakerEmailSource: 'none' as const,
            discoveredEmails: [],
            pagesScanned: [],
            confidenceScore: 0,
            confidenceLabel: 'low' as const,
            outreachRank: 'B1' as const,
        }

        const qualifiedLead: QualifiedLead = {
            ...userData.rawLead,
            enrichment,
        }

        upsertLead(qualifiedLead)
        await pushData(qualifiedLead)
    })

    return router
}
