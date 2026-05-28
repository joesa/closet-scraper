import { resolveMx } from 'node:dns/promises'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

import { gotScraping } from 'crawlee'

import { getCachedPattern, getCachedValidation, updateDomainCache } from './domain-cache.js'
import type { EnrichmentResult } from './types.js'

const CONTACT_CANDIDATE_PATHS = [
  '/contact',
  '/contact-us',
  '/contactus',
  '/about',
  '/about-us',
  '/team',
  '/leadership',
  '/staff',
]

const LINK_HINTS = [
  'contact',
  'about',
  'estimate',
  'quote',
  'team',
  'owner',
  'founder',
  'leadership',
  'staff',
  'president',
  'ceo',
  'principal',
]

const DECISION_TITLE_REGEX = /(owner|founder|co-founder|ceo|chief executive officer|president|principal|managing partner|partner|director|managing director)/i
const NAME_REGEX = /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}$/
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const EMAIL_BLOCKLIST_PARTS = [
  'example.com', 'domain.com', 'test.com', 'email.com', 'sample.com',
  'yoursite.com', 'yourdomain.com', 'website.com', 'mysite.com',
  'sentry.io', 'sentry', 'wix', 'bootstrap', 'cloudflare',
  'placeholder', 'changeme',
]
const EMAIL_BLOCKLIST_SUFFIXES = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.css', '.js']
const EMAIL_BLOCKLIST_LOCAL_PARTS = new Set([
  'user', 'example', 'test', 'email', 'name', 'your', 'yourname',
  'firstname', 'lastname', 'john', 'jane', 'johndoe', 'janedoe',
  'johnsmith', 'sample', 'demo', 'dummy', 'placeholder',
])

export const FRANCHISE_EMAIL_DOMAINS = new Set([
  'calclosets.com', 'californiaclosets.com', 'closetsbydesign.com',
  'containerstore.com', 'tailoredcloset.com', 'closetfactory.com',
  'shelfgenie.com',
])

export function isFranchiseEmail(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase() || ''
  return FRANCHISE_EMAIL_DOMAINS.has(domain)
}
const ROLE_LOCAL_PARTS = new Set([
  'info',
  'support',
  'sales',
  'contact',
  'hello',
  'admin',
  'office',
  'team',
  'marketing',
  'service',
  'help',
  'billing',
  'jobs',
  'careers',
])

const COMMON_PATTERNS: EmailPattern[] = [
  'first.last',
  'first',
  'f.last',
  'flast',
  'firstl',
]

type ClassifyOptions = {
  maxSubPages?: number
  secondPassPages?: number
  decisionMakerMaxPages?: number
  requestTimeoutMs?: number
  emailConfidenceThreshold?: number
  enableMxCheck?: boolean
  enableSmtpCheck?: boolean
  smtpTimeoutMs?: number
  smtpMinIntervalMs?: number
  smtpMaxProbesPerDomain?: number
  domainCachePatternTtlDays?: number
  domainCacheValidationTtlDays?: number
}

type ScannedPage = {
  url: string
  html: string
}

type DecisionMaker = {
  name: string
  title: string
  sourceUrl: string
}

type EmailPattern = 'first' | 'first.last' | 'f.last' | 'flast' | 'firstl'

type CandidateEmail = {
  name: string
  title: string
  email: string
  source: string
  emailType: 'personal' | 'role' | 'unknown'
  confidence: number
}

export type ValidationOptions = {
  enableMxCheck: boolean
  enableSmtpCheck: boolean
  smtpTimeoutMs: number
  smtpMinIntervalMs: number
  smtpMaxProbesPerDomain: number
  cacheValidationTtlDays: number
}

type SmtpProbeResult = {
  accepted: boolean | null
  code: number | null
}

type DomainValidation = {
  mxValid: boolean
  mxHosts: string[]
  catchAll: boolean | null
}

const smtpProbeCounter = new Map<string, number>()
const smtpProbeLastAt = new Map<string, number>()
const catchAllCache = new Map<string, boolean | null>()

function normalizeWebsite(input: string): string | null {
  if (!input) return null
  let url = input.trim()
  if (!url) return null

  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`
  }

  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return null
  }
}

function hostnameWithoutWww(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return ''
  }
}

function buildContactCandidates(websiteUrl: string): string[] {
  const candidates = new Set<string>()

  try {
    const base = new URL(websiteUrl)
    candidates.add(base.toString())
    for (const path of CONTACT_CANDIDATE_PATHS) {
      const u = new URL(path, base)
      candidates.add(u.toString())
    }
  } catch {
    candidates.add(websiteUrl)
  }

  return [...candidates]
}

function normalizeEmail(email: string): string {
  return email.trim().replace(/[),.;:]+$/g, '').toLowerCase()
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/\\u003e/gi, '>')
    .replace(/\\u003c/gi, '<')
    .replace(/u003e/gi, '>')
    .replace(/u003c/gi, '<')
}

function deobfuscateEmailText(text: string): string {
  return text
    .replace(/\s*(\[at\]|\(at\)|\{at\})\s*/gi, '@')
    .replace(/\s*(\[dot\]|\(dot\)|\{dot\})\s*/gi, '.')
    .replace(/\s+at\s+/gi, '@')
    .replace(/\s+dot\s+/gi, '.')
}

function cleanText(text: string): string {
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

function isLikelyValidEmail(email: string): boolean {
  const normalized = normalizeEmail(email)
  if (!normalized.includes('@')) return false
  if (EMAIL_BLOCKLIST_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return false
  if (EMAIL_BLOCKLIST_PARTS.some((part) => normalized.includes(part))) return false
  const localPart = normalized.split('@')[0] || ''
  if (EMAIL_BLOCKLIST_LOCAL_PARTS.has(localPart)) return false
  return true
}

function isRoleMailbox(email: string): boolean {
  const local = email.split('@')[0]?.toLowerCase() || ''
  return ROLE_LOCAL_PARTS.has(local)
}

function parseName(fullName: string): { first: string; last: string } | null {
  const normalized = fullName.replace(/\s+/g, ' ').trim()
  if (!NAME_REGEX.test(normalized)) return null

  const parts = normalized.split(' ')
  if (parts.length < 2) return null
  return {
    first: parts[0].toLowerCase(),
    last: parts[parts.length - 1].toLowerCase(),
  }
}

function extractEmailsFromText(text: string): string[] {
  const decoded = decodeHtmlEntities(text)
  const found = decoded.match(EMAIL_REGEX) || []
  const deduped = new Set<string>()
  for (const raw of found) {
    const normalized = normalizeEmail(raw)
    if (!isLikelyValidEmail(normalized)) continue
    deduped.add(normalized)
  }
  return [...deduped]
}

function extractEmailsFromObfuscatedText(text: string): string[] {
  return extractEmailsFromText(deobfuscateEmailText(text))
}

function decodeCloudflareEmail(hex: string): string | null {
  if (!hex || hex.length < 4 || hex.length % 2 !== 0) return null
  try {
    const key = Number.parseInt(hex.slice(0, 2), 16)
    let decoded = ''
    for (let i = 2; i < hex.length; i += 2) {
      const code = Number.parseInt(hex.slice(i, i + 2), 16) ^ key
      decoded += String.fromCharCode(code)
    }
    return decoded
  } catch {
    return null
  }
}

function extractCloudflareEmails(html: string): string[] {
  const deduped = new Set<string>()
  const cfRegex = /data-cfemail=["']([0-9a-fA-F]+)["']/g
  let match: RegExpExecArray | null
  do {
    match = cfRegex.exec(html)
    if (!match?.[1]) continue
    const decoded = decodeCloudflareEmail(match[1])
    if (!decoded) continue
    const normalized = normalizeEmail(decoded)
    if (!isLikelyValidEmail(normalized)) continue
    deduped.add(normalized)
  } while (match)
  return [...deduped]
}

function extractEmailsFromMailto(html: string): string[] {
  const deduped = new Set<string>()
  const mailtoRegex = /mailto:([^"'?#\s>]+)/gi
  let match: RegExpExecArray | null
  do {
    match = mailtoRegex.exec(html)
    if (!match?.[1]) continue
    const decoded = decodeURIComponent(match[1])
    const normalized = normalizeEmail(decoded)
    if (!isLikelyValidEmail(normalized)) continue
    deduped.add(normalized)
  } while (match)
  return [...deduped]
}

function extractEmailsFromHtml(html: string): string[] {
  const deduped = new Set<string>()
  for (const email of extractEmailsFromText(html)) deduped.add(email)
  for (const email of extractEmailsFromObfuscatedText(html)) deduped.add(email)
  for (const email of extractEmailsFromMailto(html)) deduped.add(email)
  for (const email of extractCloudflareEmails(html)) deduped.add(email)
  return [...deduped]
}

function buildCandidateLinksFromHtml(html: string, baseUrl: string): string[] {
  const candidates = new Set<string>()
  const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  const base = new URL(baseUrl)

  let match: RegExpExecArray | null
  do {
    match = anchorRegex.exec(html)
    const href = match?.[1]
    const inner = match?.[2] || ''
    if (!href) continue
    if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue

    const anchorText = cleanText(inner)
    const hrefLower = href.toLowerCase()
    const likelyRelevant = LINK_HINTS.some((hint) => anchorText.includes(hint) || hrefLower.includes(hint))
    if (!likelyRelevant) continue

    try {
      const absolute = new URL(href, base)
      if (!/^https?:$/i.test(absolute.protocol)) continue
      if (absolute.hostname !== base.hostname) continue
      absolute.hash = ''
      candidates.add(absolute.toString())
    } catch {
      continue
    }
  } while (match)

  return [...candidates]
}

function buildInternalLinksFromHtml(html: string, baseUrl: string): string[] {
  const candidates = new Set<string>()
  const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi
  const base = new URL(baseUrl)

  let match: RegExpExecArray | null
  do {
    match = anchorRegex.exec(html)
    const href = match?.[1]
    if (!href) continue
    if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue

    try {
      const absolute = new URL(href, base)
      if (!/^https?:$/i.test(absolute.protocol)) continue
      if (absolute.hostname !== base.hostname) continue
      if (/(\.(png|jpg|jpeg|gif|webp|svg|pdf|zip|mp4))$/i.test(absolute.pathname)) continue
      absolute.hash = ''
      candidates.add(absolute.toString())
    } catch {
      continue
    }
  } while (match)

  return [...candidates]
}

function hasContactSignals(html: string): boolean {
  const signals = [
    /<form\b/i,
    /name=["']?(name|first_name|fullname)["']?/i,
    /name=["']?(email|email_address)["']?/i,
    /type=["']?submit["']?/i,
    /\b(contact us|get a quote|request estimate)\b/i,
  ]

  return signals.some((rx) => rx.test(html))
}

function extractDecisionMakersFromJsonLd(html: string, pageUrl: string): DecisionMaker[] {
  const found: DecisionMaker[] = []
  const scripts = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || []

  for (const block of scripts) {
    const jsonText = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim()
    if (!jsonText) continue

    try {
      const parsed = JSON.parse(jsonText)
      const items = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed['@graph'])
          ? parsed['@graph']
          : [parsed]

      for (const item of items) {
        const type = String(item?.['@type'] || '').toLowerCase()
        const isPerson = type === 'person' || (Array.isArray(item?.['@type']) && item['@type'].includes('Person'))
        if (!isPerson) continue

        const name = String(item?.name || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
        const title = String(item?.jobTitle || item?.roleName || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
        if (!name || !title) continue
        if (!NAME_REGEX.test(name) || !DECISION_TITLE_REGEX.test(title)) continue

        found.push({ name, title, sourceUrl: pageUrl })
      }
    } catch {
      continue
    }
  }

  return found
}

function cleanExtractedText(raw: string): string {
  return raw.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

function extractDecisionMakersFromText(html: string, pageUrl: string): DecisionMaker[] {
  const found: DecisionMaker[] = []
  const text = html.replace(/<[^>]*>/g, '\n').replace(/\t/g, ' ').replace(/[ ]{2,}/g, ' ')

  const nameThenTitle = new RegExp(
    `([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){1,2})\\s*(?:-|,|\\u2013|\\u2014|\\|)\\s*(${DECISION_TITLE_REGEX.source})`,
    'gi'
  )
  const titleThenName = new RegExp(
    `(${DECISION_TITLE_REGEX.source})\\s*(?:-|,|\\u2013|\\u2014|\\|)?\\s*([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){1,2})`,
    'gi'
  )

  let match: RegExpExecArray | null
  do {
    match = nameThenTitle.exec(text)
    const name = cleanExtractedText(match?.[1] || '')
    const title = cleanExtractedText(match?.[2] || '')
    if (!name || !title) continue
    if (!NAME_REGEX.test(name) || !DECISION_TITLE_REGEX.test(title)) continue
    found.push({ name, title, sourceUrl: pageUrl })
  } while (match)

  do {
    match = titleThenName.exec(text)
    const title = cleanExtractedText(match?.[1] || '')
    const name = cleanExtractedText(match?.[2] || '')
    if (!name || !title) continue
    if (!NAME_REGEX.test(name) || !DECISION_TITLE_REGEX.test(title)) continue
    found.push({ name, title, sourceUrl: pageUrl })
  } while (match)

  return found
}

function dedupeDecisionMakers(items: DecisionMaker[]): DecisionMaker[] {
  const seen = new Set<string>()
  const out: DecisionMaker[] = []
  for (const item of items) {
    const key = `${item.name.toLowerCase()}|${item.title.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

function classifyEmailType(email: string): 'personal' | 'role' | 'unknown' {
  if (!email.includes('@')) return 'unknown'
  return isRoleMailbox(email) ? 'role' : 'personal'
}

function buildPatternLocalPart(pattern: EmailPattern, first: string, last: string): string {
  const f = first.toLowerCase()
  const l = last.toLowerCase()
  const fi = f[0] || ''
  const li = l[0] || ''

  switch (pattern) {
    case 'first':
      return f
    case 'first.last':
      return `${f}.${l}`
    case 'f.last':
      return `${fi}.${l}`
    case 'flast':
      return `${fi}${l}`
    case 'firstl':
      return `${f}${li}`
    default:
      return f
  }
}

function inferDomainPattern(
  decisionMakers: DecisionMaker[],
  knownEmails: string[],
  siteDomain: string,
  cachePatternTtlDays: number
): EmailPattern | null {
  const cached = getCachedPattern(siteDomain, cachePatternTtlDays)
  const counts = new Map<EmailPattern, number>()

  const domainEmails = knownEmails.filter((email) => {
    const domain = email.split('@')[1] || ''
    return domain.toLowerCase() === siteDomain && !isRoleMailbox(email)
  })

  for (const person of decisionMakers) {
    const parsed = parseName(person.name)
    if (!parsed) continue

    for (const email of domainEmails) {
      const local = email.split('@')[0] || ''
      for (const pattern of COMMON_PATTERNS) {
        if (local === buildPatternLocalPart(pattern, parsed.first, parsed.last)) {
          counts.set(pattern, (counts.get(pattern) || 0) + 1)
        }
      }
    }
  }

  if (counts.size === 0) {
    return (cached as EmailPattern | null) || null
  }

  const inferred = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null
  if (inferred) {
    updateDomainCache(siteDomain, { inferredPattern: inferred })
  }

  return inferred
}

function looksLikeNameEmailMatch(name: string, email: string): boolean {
  const parsed = parseName(name)
  if (!parsed) return false
  const local = email.split('@')[0]?.toLowerCase() || ''
  if (!local) return false

  return (
    local === parsed.first ||
    local.includes(`${parsed.first}.${parsed.last}`) ||
    local.includes(`${parsed.first}${parsed.last}`) ||
    local.includes(`${parsed.first[0] || ''}${parsed.last}`) ||
    local.includes(parsed.last)
  )
}

function generateCandidateEmailsForPerson(
  person: DecisionMaker,
  siteDomain: string,
  inferredPattern: EmailPattern | null
): string[] {
  const parsed = parseName(person.name)
  if (!parsed || !siteDomain) return []

  const candidates = new Set<string>()
  const patternOrder = inferredPattern
    ? [inferredPattern, ...COMMON_PATTERNS.filter((p) => p !== inferredPattern)]
    : COMMON_PATTERNS

  for (const pattern of patternOrder) {
    const local = buildPatternLocalPart(pattern, parsed.first, parsed.last)
    candidates.add(`${local}@${siteDomain}`)
  }

  return [...candidates]
}

function pickPrimaryEmail(emails: string[], websiteUrl: string): string | null {
  if (!emails.length) return null
  const siteHost = hostnameWithoutWww(websiteUrl)

  const scored = [...emails]
    .map((email) => {
      const lower = email.toLowerCase()
      const domain = lower.split('@')[1] || ''
      let score = 0
      if (siteHost && domain === siteHost) score += 4
      if (/^(owner|ceo|founder|president|principal)@/.test(lower)) score += 3
      if (/^(info|hello|contact|sales|admin|support)@/.test(lower)) score -= 2
      if (/^(noreply|no-reply|donotreply)@/.test(lower)) score -= 5
      return { email: lower, score }
    })
    .sort((a, b) => b.score - a.score)

  return scored[0]?.email || emails[0] || null
}

function computeConfidence(params: {
  primaryEmail: string | null
  discoveredEmails: string[]
  websiteUrl: string
  sawContactForm: boolean
  reason: EnrichmentResult['reason']
  decisionMakerEmail: string | null
  decisionMakerEmailConfidence: number
}): { score: number; label: 'low' | 'medium' | 'high' } {
  let score = 10
  if (params.primaryEmail) score += 35
  if (params.discoveredEmails.length > 1) score += 10
  if (params.sawContactForm) score += 10
  if (params.decisionMakerEmail) score += Math.min(35, Math.floor(params.decisionMakerEmailConfidence * 0.35))

  const siteHost = hostnameWithoutWww(params.websiteUrl)
  if (siteHost && params.primaryEmail) {
    const domain = params.primaryEmail.split('@')[1] || ''
    if (domain === siteHost) score += 15
  }

  if (params.reason === 'contact_page_fetch_failed') score -= 20
  if (params.reason === 'missing_website') score = 0

  score = Math.max(0, Math.min(100, score))
  const label: 'low' | 'medium' | 'high' = score >= 75 ? 'high' : score >= 45 ? 'medium' : 'low'
  return { score, label }
}

function computeOutreachRank(params: {
  pipeline: EnrichmentResult['pipeline']
  reason: EnrichmentResult['reason']
  primaryEmail: string | null
  confidenceLabel: 'low' | 'medium' | 'high'
}): 'A1' | 'A2' | 'B1' | 'B2' {
  if (params.pipeline === 'PIPELINE_A') {
    if (params.primaryEmail && params.confidenceLabel !== 'low') return 'A1'
    return 'A2'
  }

  if (params.reason === 'missing_website') return 'B1'
  return 'B2'
}

async function fetchHtml(url: string, requestTimeoutMs: number): Promise<string | null> {
  try {
    const response = await gotScraping({
      url,
      timeout: { request: requestTimeoutMs },
      retry: { limit: 1 },
      throwHttpErrors: false,
    })
    if (!response.body || typeof response.body !== 'string') return null
    return response.body
  } catch {
    return null
  }
}

async function maybeValidateDomain(domain: string, options: ValidationOptions): Promise<DomainValidation> {
  if (!domain || !options.enableMxCheck) {
    return { mxValid: false, mxHosts: [], catchAll: null }
  }

  const cached = getCachedValidation(domain, options.cacheValidationTtlDays)
  if (cached) {
    return cached
  }

  let mxHosts: string[] = []
  try {
    const records = await resolveMx(domain)
    mxHosts = records
      .sort((a, b) => a.priority - b.priority)
      .map((r) => r.exchange)
      .filter(Boolean)
  } catch {
    mxHosts = []
  }

  if (!mxHosts.length) {
    updateDomainCache(domain, { mxValid: false, mxHosts: [], catchAll: null })
    return { mxValid: false, mxHosts: [], catchAll: null }
  }

  if (!options.enableSmtpCheck) {
    updateDomainCache(domain, { mxValid: true, mxHosts, catchAll: null })
    return { mxValid: true, mxHosts, catchAll: null }
  }

  if (catchAllCache.has(domain)) {
    return { mxValid: true, mxHosts, catchAll: catchAllCache.get(domain) ?? null }
  }

  const randomLocal = `nope_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`
  const randomEmail = `${randomLocal}@${domain}`
  const probe = await smtpProbe(randomEmail, mxHosts, domain, options)
  const catchAll = probe.accepted === true
  catchAllCache.set(domain, catchAll)
  updateDomainCache(domain, { mxValid: true, mxHosts, catchAll })

  return { mxValid: true, mxHosts, catchAll }
}

async function smtpProbe(
  candidateEmail: string,
  mxHosts: string[],
  domain: string,
  options: ValidationOptions
): Promise<SmtpProbeResult> {
  if (!options.enableSmtpCheck || !mxHosts.length) {
    return { accepted: null, code: null }
  }

  const currentCount = smtpProbeCounter.get(domain) || 0
  if (currentCount >= options.smtpMaxProbesPerDomain) {
    return { accepted: null, code: null }
  }

  const lastAt = smtpProbeLastAt.get(domain) || 0
  const elapsed = Date.now() - lastAt
  if (elapsed < options.smtpMinIntervalMs) {
    await delay(options.smtpMinIntervalMs - elapsed)
  }

  smtpProbeCounter.set(domain, currentCount + 1)
  smtpProbeLastAt.set(domain, Date.now())

  for (const mx of mxHosts.slice(0, 2)) {
    const result = await smtpProbeHost(candidateEmail, mx, options.smtpTimeoutMs)
    if (result.accepted !== null) return result
  }

  return { accepted: null, code: null }
}

async function smtpProbeHost(candidateEmail: string, mxHost: string, timeoutMs: number): Promise<SmtpProbeResult> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: mxHost, port: 25 })
    socket.setEncoding('utf8')
    socket.setTimeout(timeoutMs)

    let buffer = ''
    let resolved = false
    let stage: 'greeting' | 'helo' | 'mailfrom' | 'rcpt' | 'quit' = 'greeting'

    const done = (result: SmtpProbeResult): void => {
      if (resolved) return
      resolved = true
      try {
        socket.end()
        socket.destroy()
      } catch {
        // no-op
      }
      resolve(result)
    }

    const send = (line: string): void => {
      try {
        socket.write(`${line}\r\n`)
      } catch {
        done({ accepted: null, code: null })
      }
    }

    const handleCode = (code: number): void => {
      if (stage === 'greeting' && code === 220) {
        stage = 'helo'
        send('HELO probe.local')
        return
      }

      if (stage === 'helo' && code >= 200 && code < 400) {
        stage = 'mailfrom'
        send('MAIL FROM:<probe@probe.local>')
        return
      }

      if (stage === 'mailfrom' && code >= 200 && code < 400) {
        stage = 'rcpt'
        send(`RCPT TO:<${candidateEmail}>`)
        return
      }

      if (stage === 'rcpt') {
        stage = 'quit'
        send('QUIT')
        if (code === 250 || code === 251 || code === 252) {
          done({ accepted: true, code })
        } else if (code >= 500 && code <= 599) {
          done({ accepted: false, code })
        } else {
          done({ accepted: null, code })
        }
        return
      }

      if (code >= 500 && code <= 599) {
        done({ accepted: null, code })
      }
    }

    socket.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''

      for (const line of lines) {
        const code = Number.parseInt(line.slice(0, 3), 10)
        if (!Number.isFinite(code)) continue
        handleCode(code)
        if (resolved) return
      }
    })

    socket.on('timeout', () => done({ accepted: null, code: null }))
    socket.on('error', () => done({ accepted: null, code: null }))
    socket.on('end', () => {
      if (!resolved) done({ accepted: null, code: null })
    })
  })
}

async function pickBestDecisionMakerCandidate(params: {
  decisionMakers: DecisionMaker[]
  scannedPages: ScannedPage[]
  siteDomain: string
  inferredPattern: EmailPattern | null
  threshold: number
  validationOptions: ValidationOptions
}): Promise<CandidateEmail | null> {
  const {
    decisionMakers,
    scannedPages,
    siteDomain,
    inferredPattern,
    threshold,
    validationOptions,
  } = params
  if (!decisionMakers.length || !siteDomain) return null

  const domainValidation = await maybeValidateDomain(siteDomain, validationOptions)

  const candidates: CandidateEmail[] = []

  for (const person of decisionMakers) {
    const page = scannedPages.find((p) => p.url === person.sourceUrl)
    const pageEmails = page ? extractEmailsFromHtml(page.html) : []

    // Strongest signal: personal email on the same page as decision-maker profile.
    const exactMatch = pageEmails.find((email) => {
      const domain = email.split('@')[1] || ''
      return domain.toLowerCase() === siteDomain && !isRoleMailbox(email) && looksLikeNameEmailMatch(person.name, email)
    })

    if (exactMatch) {
      let confidence = 40
      if (domainValidation.mxValid) confidence += 10

      const smtp = await smtpProbe(exactMatch, domainValidation.mxHosts, siteDomain, validationOptions)
      if (smtp.accepted === true) confidence += 20
      if (smtp.accepted === false) confidence -= 30
      if (domainValidation.catchAll === true) confidence -= 25

      candidates.push({
        name: person.name,
        title: person.title,
        email: exactMatch,
        source: 'team_page_exact',
        emailType: 'personal',
        confidence: Math.max(0, Math.min(100, confidence)),
      })
      continue
    }

    const generated = generateCandidateEmailsForPerson(person, siteDomain, inferredPattern)
    if (!generated.length) continue

    const top = generated[0]
    let confidence = inferredPattern ? 25 : 15
    if (domainValidation.mxValid) confidence += 10

    const smtp = await smtpProbe(top, domainValidation.mxHosts, siteDomain, validationOptions)
    if (smtp.accepted === true) confidence += 20
    if (smtp.accepted === false) confidence -= 30
    if (domainValidation.catchAll === true) confidence -= 25

    candidates.push({
      name: person.name,
      title: person.title,
      email: top,
      source: inferredPattern ? 'pattern+validation' : 'heuristic+validation',
      emailType: classifyEmailType(top),
      confidence: Math.max(0, Math.min(100, confidence)),
    })
  }

  const best = candidates.sort((a, b) => b.confidence - a.confidence)[0] || null
  if (!best) return null

  return best.confidence >= threshold ? best : best
}

export async function classifyLeadWebsite(websiteUrl: string | null, options?: ClassifyOptions): Promise<EnrichmentResult> {
  const maxSubPages = Math.max(1, options?.maxSubPages ?? 3)
  const secondPassPages = Math.max(0, options?.secondPassPages ?? 2)
  const decisionMakerMaxPages = Math.max(1, options?.decisionMakerMaxPages ?? 6)
  const requestTimeoutMs = Math.max(3000, options?.requestTimeoutMs ?? 15000)
  const emailConfidenceThreshold = Math.max(0, Math.min(100, options?.emailConfidenceThreshold ?? 75))

  const validationOptions: ValidationOptions = {
    enableMxCheck: options?.enableMxCheck ?? false,
    enableSmtpCheck: options?.enableSmtpCheck ?? false,
    smtpTimeoutMs: Math.max(3000, options?.smtpTimeoutMs ?? 8000),
    smtpMinIntervalMs: Math.max(500, options?.smtpMinIntervalMs ?? 1500),
    smtpMaxProbesPerDomain: Math.max(1, options?.smtpMaxProbesPerDomain ?? 3),
    cacheValidationTtlDays: Math.max(1, options?.domainCacheValidationTtlDays ?? 14),
  }
  const cachePatternTtlDays = Math.max(1, options?.domainCachePatternTtlDays ?? 90)

  const normalized = normalizeWebsite(websiteUrl || '')
  if (!normalized) {
    return {
      pipeline: 'PIPELINE_B',
      reason: 'missing_website',
      contactPageUrl: null,
      primaryEmail: null,
      decisionMakerName: null,
      decisionMakerTitle: null,
      decisionMakerEmail: null,
      decisionMakerEmailType: 'unknown',
      decisionMakerEmailConfidence: 0,
      decisionMakerEmailSource: 'none',
      discoveredEmails: [],
      pagesScanned: [],
      confidenceScore: 0,
      confidenceLabel: 'low',
      outreachRank: 'B1',
    }
  }

  const pagesScanned: string[] = []
  const scannedSet = new Set<string>()
  const scannedPages: ScannedPage[] = []
  const discoveredEmails = new Set<string>()
  const decisionMakers = new Set<string>()
  const decisionMakerRecords: DecisionMaker[] = []
  let sawContactForm = false
  let contactPageUrl: string | null = null
  let successfulFetches = 0
  const secondPassCandidates = new Set<string>()

  function collectFromPage(url: string, html: string): void {
    for (const email of extractEmailsFromHtml(html)) discoveredEmails.add(email)

    const people = dedupeDecisionMakers([
      ...extractDecisionMakersFromJsonLd(html, url),
      ...extractDecisionMakersFromText(html, url),
    ])

    for (const person of people) {
      const key = `${person.name.toLowerCase()}|${person.title.toLowerCase()}`
      if (decisionMakers.has(key)) continue
      decisionMakers.add(key)
      decisionMakerRecords.push(person)
    }
  }

  function markScanned(url: string, html: string): void {
    if (scannedSet.has(url)) return
    scannedSet.add(url)
    pagesScanned.push(url)
    scannedPages.push({ url, html })
  }

  const homepageHtml = await fetchHtml(normalized, requestTimeoutMs)
  if (homepageHtml) {
    successfulFetches += 1
    markScanned(normalized, homepageHtml)
    collectFromPage(normalized, homepageHtml)

    if (hasContactSignals(homepageHtml)) {
      sawContactForm = true
      contactPageUrl = normalized
    }

    const dynamicCandidates = buildCandidateLinksFromHtml(homepageHtml, normalized)
    const staticCandidates = buildContactCandidates(normalized)
    const subPageCandidates = Array.from(new Set([...dynamicCandidates, ...staticCandidates].filter((u) => u !== normalized))).slice(0, maxSubPages)

    for (const url of subPageCandidates) {
      const html = await fetchHtml(url, requestTimeoutMs)
      if (!html) continue

      successfulFetches += 1
      markScanned(url, html)
      collectFromPage(url, html)

      if (!contactPageUrl && hasContactSignals(html)) {
        sawContactForm = true
        contactPageUrl = url
      }

      for (const extraUrl of buildInternalLinksFromHtml(html, normalized)) {
        if (!scannedSet.has(extraUrl)) secondPassCandidates.add(extraUrl)
      }
    }

    const shouldRunSecondPass = discoveredEmails.size === 0 || decisionMakerRecords.length === 0
    if (shouldRunSecondPass && secondPassPages > 0) {
      const fallbackPages = [...secondPassCandidates].slice(0, secondPassPages)
      for (const fallbackUrl of fallbackPages) {
        const html = await fetchHtml(fallbackUrl, requestTimeoutMs)
        if (!html) continue

        successfulFetches += 1
        markScanned(fallbackUrl, html)
        collectFromPage(fallbackUrl, html)

        if (!contactPageUrl && hasContactSignals(html)) {
          sawContactForm = true
          contactPageUrl = fallbackUrl
        }
      }
    }
  }

  const discoveredEmailList = [...discoveredEmails]
  const fallbackPrimaryEmail = pickPrimaryEmail(discoveredEmailList, normalized)
  const siteDomain = hostnameWithoutWww(normalized)

  // Warm domain cache even when no decision-maker is extracted.
  if (siteDomain && validationOptions.enableMxCheck) {
    await maybeValidateDomain(siteDomain, validationOptions)
  }

  const bestDecisionMaker = await pickBestDecisionMakerCandidate({
    decisionMakers: decisionMakerRecords.slice(0, decisionMakerMaxPages),
    scannedPages,
    siteDomain,
    threshold: emailConfidenceThreshold,
    validationOptions,
    inferredPattern: inferDomainPattern(
      decisionMakerRecords.slice(0, decisionMakerMaxPages),
      discoveredEmailList,
      siteDomain,
      cachePatternTtlDays
    ),
  })

  const useDecisionMakerAsPrimary =
    !!bestDecisionMaker &&
    bestDecisionMaker.emailType === 'personal' &&
    bestDecisionMaker.confidence >= emailConfidenceThreshold

  const primaryEmail = useDecisionMakerAsPrimary ? bestDecisionMaker.email : fallbackPrimaryEmail

  const resolvedReason: EnrichmentResult['reason'] =
    successfulFetches === 0 ? 'contact_page_fetch_failed' : sawContactForm ? 'contact_form_detected' : 'no_contact_form_detected'

  const confidence = computeConfidence({
    primaryEmail,
    discoveredEmails: discoveredEmailList,
    websiteUrl: normalized,
    sawContactForm,
    reason: resolvedReason,
    decisionMakerEmail: bestDecisionMaker?.email || null,
    decisionMakerEmailConfidence: bestDecisionMaker?.confidence || 0,
  })

  if (successfulFetches === 0) {
    return {
      pipeline: 'PIPELINE_B',
      reason: 'contact_page_fetch_failed',
      contactPageUrl: null,
      primaryEmail,
      decisionMakerName: bestDecisionMaker?.name || null,
      decisionMakerTitle: bestDecisionMaker?.title || null,
      decisionMakerEmail: bestDecisionMaker?.email || null,
      decisionMakerEmailType: bestDecisionMaker?.emailType || 'unknown',
      decisionMakerEmailConfidence: bestDecisionMaker?.confidence || 0,
      decisionMakerEmailSource: bestDecisionMaker?.source || 'none',
      discoveredEmails: discoveredEmailList,
      pagesScanned,
      confidenceScore: confidence.score,
      confidenceLabel: confidence.label,
      outreachRank: computeOutreachRank({
        pipeline: 'PIPELINE_B',
        reason: 'contact_page_fetch_failed',
        primaryEmail,
        confidenceLabel: confidence.label,
      }),
    }
  }

  const reason: EnrichmentResult['reason'] = sawContactForm ? 'contact_form_detected' : 'no_contact_form_detected'
  const pipeline: EnrichmentResult['pipeline'] = sawContactForm ? 'PIPELINE_A' : 'PIPELINE_B'

  return {
    pipeline,
    reason,
    contactPageUrl: contactPageUrl || pagesScanned[0] || null,
    primaryEmail,
    decisionMakerName: bestDecisionMaker?.name || null,
    decisionMakerTitle: bestDecisionMaker?.title || null,
    decisionMakerEmail: bestDecisionMaker?.email || null,
    decisionMakerEmailType: bestDecisionMaker?.emailType || 'unknown',
    decisionMakerEmailConfidence: bestDecisionMaker?.confidence || 0,
    decisionMakerEmailSource: bestDecisionMaker?.source || 'none',
    discoveredEmails: discoveredEmailList,
    pagesScanned,
    confidenceScore: confidence.score,
    confidenceLabel: confidence.label,
    outreachRank: computeOutreachRank({
      pipeline,
      reason,
      primaryEmail,
      confidenceLabel: confidence.label,
    }),
  }
}

export async function guessAndVerifyFallbackEmails(
  businessName: string | null,
  options: ValidationOptions
): Promise<{ email: string; confidence: number } | null> {
  if (!businessName || !options.enableSmtpCheck) return null

  // Generate a clean theoretical domain name
  const cleanName = businessName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim()
  
  if (!cleanName || cleanName.length < 4) return null
  const domain = `${cleanName}.com`

  const domainValidation = await maybeValidateDomain(domain, options)
  if (!domainValidation.mxValid || domainValidation.catchAll) {
    return null
  }

  // Common prefixes to test
  const prefixes = ['info', 'contact', 'hello', 'support', 'owner', 'office']

  for (const prefix of prefixes) {
    const candidateEmail = `${prefix}@${domain}`
    const smtp = await smtpProbe(candidateEmail, domainValidation.mxHosts, domain, options)
    if (smtp.accepted === true) {
      // If we got a positive hit and it's not a catch-all, we return it!
      return { email: candidateEmail, confidence: 80 }
    }
    // Respect the max probes limit per domain enforced internally by smtpProbe.
    // If it starts rejecting or we hit the limit, we'll gracefully break/continue.
  }

  return null
}
