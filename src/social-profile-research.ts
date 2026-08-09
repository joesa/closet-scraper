import type { PublicProfileResearch } from './types.js'

const MAX_RESEARCH_CHARS = 12_000
const MIN_RESEARCH_CHARS = 120

const ALLOWED_HOSTS = new Set([
  'facebook.com',
  'm.facebook.com',
  'www.facebook.com',
])

const BLOCKED_PATH_PARTS = ['/login', '/checkpoint', '/challenge', '/consent']
const BLOCKED_PAGE_MARKERS = [
  'log in to continue',
  'you must log in',
  'create new account',
  'confirm your identity',
  'security check required',
  'this content isn\'t available',
  'this account is private',
]

const CHROME_LINES = new Set([
  'about',
  'contact and basic info',
  'cookies',
  'forgot password?',
  'home',
  'log in',
  'menu',
  'meta',
  'privacy',
  'search',
  'settings',
  'sign up',
])

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi
const PHONE_RE = /(?:\+?\d[\s().-]{0,2}){9,}\d/g

export type PublicProfileResearchResult =
  | { research: PublicProfileResearch; reason?: never }
  | { research: null; reason: string }

export function withoutPublicProfileResearch<T extends { publicProfileResearch?: unknown }>(
  lead: T
): Omit<T, 'publicProfileResearch'> {
  const { publicProfileResearch: _discarded, ...retained } = lead
  return retained
}

function parseAllowedUrl(value: string): URL | null {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function publicProfileAboutUrl(value: string): string {
  const parsed = parseAllowedUrl(value)
  if (!parsed || !parsed.hostname.toLowerCase().includes('facebook')) return value

  if (parsed.pathname.toLowerCase() === '/profile.php') {
    const id = parsed.searchParams.get('id')?.trim()
    if (!id) return value
    const about = new URL('/profile.php', parsed.origin)
    about.searchParams.set('id', id)
    about.searchParams.set('sk', 'about')
    return about.toString()
  }

  if (/about/i.test(parsed.pathname) || /^about/i.test(parsed.searchParams.get('sk') || '')) {
    return parsed.toString()
  }
  const pathname = parsed.pathname.replace(/\/+$/, '')
  return pathname ? `${parsed.origin}${pathname}/about` : value
}

/**
 * Minimize public business-profile text before it leaves the browser process.
 * This never bypasses access controls and intentionally drops contact details,
 * navigation chrome, URLs, duplicate lines, and all media.
 */
export function buildPublicProfileResearch(input: {
  requestedUrl: string
  loadedUrl: string
  bodyText: string
  capturedAt?: string
}): PublicProfileResearchResult {
  const requested = parseAllowedUrl(input.requestedUrl)
  const loaded = parseAllowedUrl(input.loadedUrl)
  if (!requested || !loaded) return { research: null, reason: 'unsupported_or_insecure_url' }

  const loadedPath = loaded.pathname.toLowerCase()
  if (BLOCKED_PATH_PARTS.some((part) => loadedPath.includes(part))) {
    return { research: null, reason: 'access_controlled' }
  }

  const normalizedBody = input.bodyText.replace(/\s+/g, ' ').trim().toLowerCase()
  if (BLOCKED_PAGE_MARKERS.some((marker) => normalizedBody.includes(marker))) {
    return { research: null, reason: 'access_controlled' }
  }

  const seen = new Set<string>()
  const lines: string[] = []
  for (const rawLine of input.bodyText.split(/\r?\n/)) {
    const line = rawLine
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(EMAIL_RE, '[contact redacted]')
      .replace(PHONE_RE, '[contact redacted]')
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!line || line.length < 3 || CHROME_LINES.has(line.toLowerCase())) continue
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    lines.push(line)
  }

  const text = lines.join('\n').slice(0, MAX_RESEARCH_CHARS).trim()
  if (text.length < MIN_RESEARCH_CHARS) {
    return { research: null, reason: 'insufficient_public_prose' }
  }

  return {
    research: {
      sourceUrl: requested.toString(),
      text,
      capturedAt: input.capturedAt || new Date().toISOString(),
      captureMethod: 'public_browser',
    },
  }
}