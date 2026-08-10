import { createPlaywrightRouter } from 'crawlee'

import type { ScraperConfig } from './config.js'
import { classifyLeadWebsite, guessAndVerifyFallbackEmails } from './enrichment.js'
import { leadFilterFailure, normalizeBusinessDetails } from './lead-quality.js'
import {
    buildPublicProfileResearch,
    publicProfileAboutUrl,
    withoutPublicProfileResearch,
} from './social-profile-research.js'
import { upsertLead } from './state.js'
import type { QualifiedLead, RawLead, SearchSeed } from './types.js'

type RouteUserData = {
    seed?: SearchSeed
    rawLead?: RawLead
    pendingProfileUrls?: string[]
    discoveredProfileEmail?: string | null
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

async function handleGoogleConsent(page: any): Promise<void> {
    const consentHandled = await page.evaluate(() => {
        const forms = Array.from(document.querySelectorAll('form'));
        const consentForm = forms.find(f => f.action.includes('consent.google.com'));
        
        const buttons = Array.from(document.querySelectorAll('button'));
        const rejectBtn = buttons.find(b => {
            const text = (b.textContent || '').trim().toLowerCase();
            return text === 'reject all' || text === 'tout refuser' || text === 'rifiuta tutto' || text === 'alle ablehnen';
        });
        
        if (rejectBtn) {
            rejectBtn.click();
            return true;
        }

        const acceptBtn = buttons.find(b => {
            const text = (b.textContent || '').trim().toLowerCase();
            return text === 'accept all' || text === 'tout accepter' || text === 'accetta tutto' || text === 'alle akzeptieren';
        });

        if (acceptBtn) {
            acceptBtn.click();
            return true;
        }

        return false;
    });

    if (consentHandled) {
        await page.waitForTimeout(2000);
    }
}

// Detects Google's anti-bot interstitial (the "/sorry/" CAPTCHA page or an
// "unusual traffic" notice). Used on both Maps and Search so a blocked request
// fails loudly (and can be retried with a fresh session/proxy) instead of
// silently returning zero results.
async function isGoogleBlocked(page: any): Promise<boolean> {
    try {
        const currentUrl = (page.url?.() as string) || ''
        if (currentUrl.includes('/sorry/')) return true
        return await page.evaluate(() => {
            if (document.querySelector('form[action="/sorry/index"]')) return true
            const text = (document.body?.innerText || '').toLowerCase()
            return (
                text.includes('unusual traffic') ||
                text.includes('our systems have detected') ||
                text.includes('verify you') && text.includes('not a robot')
            )
        })
    } catch {
        return false
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

function publicProfileKind(input: string | null): 'social' | 'yelp' | null {
    if (!input) return null
    try {
        const url = new URL(input)
        const hostname = url.hostname.toLowerCase().replace(/^www\./, '')
        if (hostname === 'facebook.com' || hostname.endsWith('.facebook.com') ||
            hostname === 'instagram.com' || hostname.endsWith('.instagram.com')
        ) return 'social'
        if ((hostname === 'yelp.com' || hostname.endsWith('.yelp.com')) && url.pathname.toLowerCase().startsWith('/biz/')) return 'yelp'
        return null
    } catch {
        return null
    }
}

export function selectComplementaryProfileUrls(inputs: Array<string | null | undefined>): string[] {
    const selected = new Map<'social' | 'yelp', string>()
    for (const input of inputs) {
        if (!input) continue
        const kind = publicProfileKind(input)
        if (kind && !selected.has(kind)) selected.set(kind, input)
    }
    return [selected.get('yelp'), selected.get('social')].filter((url): url is string => !!url)
}

async function extractExpandedServices(page: any): Promise<string[]> {
    try {
        const servicesControl = page
            .locator('button, [role="tab"]')
            .filter({ hasText: /^Services$/i })
            .first()
        if (await servicesControl.count() === 0 || !(await servicesControl.isVisible())) return []
        await servicesControl.click({ timeout: 3000 })
        await page.waitForTimeout(750)
        return await page.evaluate(() => {
            const root = document.querySelector('[role="dialog"]') as HTMLElement | null
            if (!root) return []
            const ignored = /^(services|close|back|done|learn more|add a service)$/i
            const values = (root.innerText || '')
                .split(/\n+/)
                .map((value) => value.replace(/\s+/g, ' ').trim())
                .filter((value) => value && value.length <= 120 && !ignored.test(value))
            return [...new Set(values)].slice(0, 30)
        })
    } catch {
        return []
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
        await page.waitForTimeout(2000)
        
        await handleGoogleConsent(page)

        // Bail (and let Crawlee retry with a new session) if Maps served a
        // CAPTCHA / "unusual traffic" wall instead of results.
        if (await isGoogleBlocked(page)) {
            throw new Error(`Google Maps CAPTCHA/block hit for query "${seed.query}"`)
        }

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
        await page.waitForTimeout(1500)
        
        await handleGoogleConsent(page)

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

            const clean = (value: string | null | undefined) =>
                (value || '').replace(/\s+/g, ' ').trim()
            const categoryNodes = Array.from(document.querySelectorAll(
                'button[jsaction*="category"], button.DkEaL, [data-item-id*="category"]'
            )) as HTMLElement[]
            const categories = categoryNodes
                .map((el) => clean(el.getAttribute('aria-label') || el.textContent))
                .filter((value) => value && value.length <= 120)
            const primaryCategory = categories[0] || null

            const descriptionNode =
                (document.querySelector('[data-item-id="description"]') as HTMLElement | null) ||
                (document.querySelector('.PYvSYb') as HTMLElement | null) ||
                (document.querySelector('[aria-label^="From the business"]') as HTMLElement | null)

            const services = new Set<string>()
            const serviceNodes = Array.from(document.querySelectorAll(
                '[data-item-id*="service"], [aria-label^="Service:"], [aria-label^="Services:"]'
            )) as HTMLElement[]
            for (const node of serviceNodes) {
                const raw = clean(node.getAttribute('aria-label') || node.textContent)
                    .replace(/^services?:\s*/i, '')
                if (raw && raw.length <= 120) services.add(raw)
            }
            const serviceHeadings = (Array.from(document.querySelectorAll('h2, h3, [role="heading"]')) as HTMLElement[])
                .filter((el) => /^(services|service options|offerings)$/i.test(clean(el.textContent)))
            for (const heading of serviceHeadings) {
                const sectionText = (heading.parentElement?.innerText || '').split(/\n+/)
                for (const line of sectionText) {
                    const value = clean(line)
                    if (!value || /^(services|service options|offerings)$/i.test(value) || value.length > 120) continue
                    services.add(value)
                    if (services.size >= 30) break
                }
            }

            return {
                businessName: titleEl?.textContent?.trim() || null,
                websiteUrl: websiteAnchor?.href || null,
                phoneAriaLabel: phoneButton?.getAttribute('aria-label') || null,
                phoneText: phoneButton?.textContent?.trim() || null,
                address: addressButton?.textContent?.trim() || null,
                ratingText: ratingTextFromText || ratingTextFromAria,
                reviewText: reviewTextFromText || reviewTextFromAria,
                primaryCategory,
                additionalCategories: categories.slice(1),
                services: [...services].slice(0, 30),
                description: clean(descriptionNode?.textContent),
            }
        })

        const expandedServices = await extractExpandedServices(page)
        if (expandedServices.length > 0) {
            scraped.services = [...new Set([...scraped.services, ...expandedServices])].slice(0, 30)
        }

        const phoneNumber =
            parsePhoneFromAriaLabel(scraped.phoneAriaLabel) ||
            scraped.phoneText ||
            null

        const normalizedPlaceUrl = toAbsoluteGoogleMapsUrl(request.loadedUrl || request.url)
        if (!normalizedPlaceUrl) {
            log.warning('Failed to normalize place URL', { raw: request.loadedUrl || request.url })
            return
        }

        const normalizedMapsUrl = normalizeWebsiteFromMaps(scraped.websiteUrl)
        const mapsProfileKind = publicProfileKind(normalizedMapsUrl)
        const mapsSocialProfileUrl = mapsProfileKind === 'social' ? normalizedMapsUrl : null
        const mapsYelpUrl = mapsProfileKind === 'yelp' ? normalizedMapsUrl : null
        const ownWebsiteUrl = mapsProfileKind ? null : normalizedMapsUrl
        const businessDetails = normalizeBusinessDetails({
            sourceKeyword: seed.keyword,
            primaryCategory: scraped.primaryCategory,
            additionalCategories: scraped.additionalCategories,
            services: scraped.services,
            description: scraped.description,
        })
        const rawLead: RawLead = {
            sourceQuery: seed.query,
            sourceKeyword: seed.keyword,
            sourceLocation: seed.location,
            mapsPlaceUrl: normalizedPlaceUrl,
            businessName: scraped.businessName,
            ...businessDetails,
            websiteUrl: ownWebsiteUrl,
            socialProfileUrl: mapsSocialProfileUrl,
            yelpUrl: mapsYelpUrl,
            hasOwnWebsite: Boolean(ownWebsiteUrl),
            phoneNumber,
            address: scraped.address,
            ratingText: scraped.ratingText,
            ratingValue: parseRatingValue(scraped.ratingText),
            reviewCount: parseReviewCount(scraped.reviewText || scraped.ratingText),
        }

        const filterFailure = leadFilterFailure(rawLead, config)
        if (filterFailure) {
            log.info('Lead excluded by configured filters', {
                business: rawLead.businessName,
                reason: filterFailure,
            })
            return
        }

        if (!rawLead.websiteUrl && config.enableOmniFallback) {
            if (!rawLead.businessName) {
                log.warning('Lead missing website and businessName, skipping fallback', { url: request.url })
            } else {
                log.info('Lead missing website, engaging Omni-Channel fallback', { business: rawLead.businessName })
                const knownProfileUrls = selectComplementaryProfileUrls([
                    rawLead.yelpUrl,
                    rawLead.socialProfileUrl,
                ])
                if (knownProfileUrls.length === 2) {
                    const [profileUrl, ...pendingProfileUrls] = knownProfileUrls
                    await addRequests([{
                        url: profileUrl,
                        label: 'SOCIAL_PROFILE_SCRAPE',
                        userData: { seed, rawLead, pendingProfileUrls }
                    }])
                    return
                }

                // Search even when one profile is known so Facebook and Yelp
                // can complement each other on the same lead.
                const sq = encodeURIComponent(`site:facebook.com OR site:instagram.com OR site:yelp.com/biz "${rawLead.businessName}" "${seed.location}"`)
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
        await pushData(withoutPublicProfileResearch(qualifiedLead))

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
            
            // Check for CAPTCHA / "unusual traffic" block
            const isCaptcha = await isGoogleBlocked(page)
            if (isCaptcha) {
                log.warning('Google Search CAPTCHA hit, silently failing SERP hunt', { business: userData.rawLead.businessName })
                const knownProfileUrls = selectComplementaryProfileUrls([
                    userData.rawLead.yelpUrl,
                    userData.rawLead.socialProfileUrl,
                ])
                if (knownProfileUrls.length > 0) {
                    const [profileUrl, ...pendingProfileUrls] = knownProfileUrls
                    await addRequests([{
                        url: profileUrl,
                        label: 'SOCIAL_PROFILE_SCRAPE',
                        userData: { ...userData, pendingProfileUrls }
                    }])
                    return
                }
                // Let it fall through to SMS / Lumpy Mail by classifying with null website
                await addRequests([{
                    url: request.url, // arbitrary URL just to trigger the fallback processing
                    label: 'FINALIZE_FALLBACK',
                    userData
                }])
                return
            }

            const discoveredUrls = await page.evaluate(() => {
                const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[]
                const matches: string[] = []
                for (const a of anchors) {
                    const href = a.href
                    if (href.includes('facebook.com') || href.includes('instagram.com') || href.includes('yelp.com/biz/')) {
                        // ignore google tracking params
                        try {
                            const u = new URL(href)
                            if (u.hostname.endsWith('google.com') && u.pathname === '/url') {
                                const q = u.searchParams.get('q')
                                if (q && (q.includes('facebook.com') || q.includes('instagram.com') || q.includes('yelp.com/biz/'))) matches.push(q)
                            } else {
                                matches.push(href)
                            }
                        } catch { }
                    }
                }
                return matches
            })

            const profileUrls = selectComplementaryProfileUrls([
                userData.rawLead.yelpUrl,
                userData.rawLead.socialProfileUrl,
                ...discoveredUrls,
            ])
            if (profileUrls.length > 0) {
                const [profileUrl, ...pendingProfileUrls] = profileUrls
                log.info('Found public business profiles', { profileUrls })
                await addRequests([{
                    url: profileUrl,
                    label: 'SOCIAL_PROFILE_SCRAPE',
                    userData: { ...userData, pendingProfileUrls }
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
            const knownProfileUrls = selectComplementaryProfileUrls([
                userData.rawLead.yelpUrl,
                userData.rawLead.socialProfileUrl,
            ])
            if (knownProfileUrls.length > 0) {
                const [profileUrl, ...pendingProfileUrls] = knownProfileUrls
                await addRequests([{
                    url: profileUrl,
                    label: 'SOCIAL_PROFILE_SCRAPE',
                    userData: { ...userData, pendingProfileUrls }
                }])
                return
            }
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
            const targetUrl = publicProfileAboutUrl(request.url)

            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
            await page.waitForTimeout(2000)

            const text = await page.evaluate(() => document.body.innerText)
            if (config.publicSocialResearchEnabled) {
                const publicResearch = buildPublicProfileResearch({
                    requestedUrl: request.url,
                    loadedUrl: page.url(),
                    bodyText: text,
                })
                userData.rawLead.publicProfileResearch = publicResearch.research
                if (publicResearch.research) {
                    log.info('Captured minimized public profile prose', {
                        sourceUrl: publicResearch.research.sourceUrl,
                        chars: publicResearch.research.text.length,
                    })
                } else {
                    log.info('Public profile prose was not retained', {
                        reason: publicResearch.reason,
                    })
                }
            }
            
            // Basic email regex extraction
            const emailMatch = text.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/)
            const extractedEmail = emailMatch ? emailMatch[1].trim().toLowerCase() : null
            if (extractedEmail) userData.discoveredProfileEmail = extractedEmail

            if (publicProfileKind(request.url) === 'yelp') {
                userData.rawLead.yelpUrl = request.url
            } else {
                userData.rawLead.socialProfileUrl = request.url
            }

            const [nextProfileUrl, ...remainingProfileUrls] = userData.pendingProfileUrls ?? []
            if (nextProfileUrl) {
                await addRequests([{
                    url: nextProfileUrl,
                    label: 'SOCIAL_PROFILE_SCRAPE',
                    userData: { ...userData, pendingProfileUrls: remainingProfileUrls }
                }])
                return
            }

            const profileEmail = userData.discoveredProfileEmail || extractedEmail
            if (profileEmail) {
                log.info('Extracted a public contact email from social profile')
                // A social profile is a contact channel, not an owned website.
                const qualifiedLead: QualifiedLead = {
                    ...userData.rawLead,
                    enrichment: {
                        pipeline: 'PIPELINE_B' as const,
                        reason: 'social_profile_extraction' as const,
                        contactPageUrl: targetUrl,
                        primaryEmail: profileEmail,
                        decisionMakerName: null,
                        decisionMakerTitle: null,
                        decisionMakerEmail: profileEmail,
                        decisionMakerEmailType: 'unknown',
                        decisionMakerEmailConfidence: 80,
                        decisionMakerEmailSource: 'social',
                        discoveredEmails: [profileEmail],
                        pagesScanned: [targetUrl],
                        confidenceScore: 80,
                        confidenceLabel: 'medium' as const,
                        outreachRank: 'B1' as const,
                    }
                }
                upsertLead(qualifiedLead)
                await pushData(withoutPublicProfileResearch(qualifiedLead))
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
            const [nextProfileUrl, ...remainingProfileUrls] = userData.pendingProfileUrls ?? []
            if (nextProfileUrl) {
                await addRequests([{
                    url: nextProfileUrl,
                    label: 'SOCIAL_PROFILE_SCRAPE',
                    userData: { ...userData, pendingProfileUrls: remainingProfileUrls }
                }])
                return
            }
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
        
        let foundEmail: string | null = userData.discoveredProfileEmail || null
        const fallback = foundEmail
            ? null
            : await guessAndVerifyFallbackEmails(userData.rawLead.businessName, {
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
            pipeline: 'PIPELINE_B' as const,
            reason: userData.discoveredProfileEmail
                ? 'social_profile_extraction' as const
                : 'smtp_domain_guessing' as const,
            contactPageUrl: null,
            primaryEmail: foundEmail,
            decisionMakerName: null,
            decisionMakerTitle: null,
            decisionMakerEmail: foundEmail,
            decisionMakerEmailType: 'unknown' as const,
            decisionMakerEmailConfidence: userData.discoveredProfileEmail ? 80 : fallback?.confidence || 0,
            decisionMakerEmailSource: userData.discoveredProfileEmail
                ? 'social' as const
                : 'smtp_guess' as const,
            discoveredEmails: [foundEmail],
            pagesScanned: [],
            confidenceScore: userData.discoveredProfileEmail ? 80 : fallback?.confidence || 0,
            confidenceLabel: 'medium' as const,
            outreachRank: 'B1' as const,
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
        await pushData(withoutPublicProfileResearch(qualifiedLead))
    })

    return router
}
