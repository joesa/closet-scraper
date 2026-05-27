import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type CachedEmailPattern = 'first' | 'first.last' | 'f.last' | 'flast' | 'firstl'

type DomainCacheEntry = {
  inferredPattern?: CachedEmailPattern
  patternUpdatedAt?: string
  mxValid?: boolean
  mxHosts?: string[]
  catchAll?: boolean | null
  validationUpdatedAt?: string
  updatedAt: string
}

type DomainCacheFile = {
  version: 1
  domains: Record<string, DomainCacheEntry>
}

const state: {
  enabled: boolean
  filePath: string
  loaded: boolean
  dirty: boolean
  data: DomainCacheFile
} = {
  enabled: true,
  filePath: path.join(process.cwd(), 'storage', 'domain-email-cache.json'),
  loaded: false,
  dirty: false,
  data: {
    version: 1,
    domains: {},
  },
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^www\./, '')
}

export function configureDomainCache(options: { enabled: boolean; filePath: string }): void {
  state.enabled = options.enabled
  state.filePath = options.filePath
}

export async function loadDomainCache(): Promise<void> {
  if (!state.enabled || state.loaded) {
    state.loaded = true
    return
  }

  try {
    const raw = await readFile(state.filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<DomainCacheFile>
    if (parsed && parsed.version === 1 && parsed.domains && typeof parsed.domains === 'object') {
      state.data = {
        version: 1,
        domains: parsed.domains as Record<string, DomainCacheEntry>,
      }
    }
  } catch {
    // Missing or malformed cache file should not block scraping.
  } finally {
    state.loaded = true
  }
}

export function getDomainCacheEntry(domain: string): DomainCacheEntry | null {
  if (!state.enabled) return null
  const key = normalizeDomain(domain)
  if (!key) return null
  return state.data.domains[key] || null
}

function isFresh(timestamp: string | undefined, ttlDays: number): boolean {
  if (!timestamp) return false
  if (ttlDays <= 0) return false

  const last = Date.parse(timestamp)
  if (!Number.isFinite(last)) return false

  const ttlMs = ttlDays * 24 * 60 * 60 * 1000
  return Date.now() - last <= ttlMs
}

export function getCachedPattern(domain: string, ttlDays: number): CachedEmailPattern | null {
  const entry = getDomainCacheEntry(domain)
  if (!entry?.inferredPattern) return null

  const patternTs = entry.patternUpdatedAt || entry.updatedAt
  if (!isFresh(patternTs, ttlDays)) return null
  return entry.inferredPattern
}

export function getCachedValidation(
  domain: string,
  ttlDays: number
): { mxValid: boolean; mxHosts: string[]; catchAll: boolean | null } | null {
  const entry = getDomainCacheEntry(domain)
  if (!entry) return null

  const validationTs = entry.validationUpdatedAt || entry.updatedAt
  if (!isFresh(validationTs, ttlDays)) return null
  if (!entry.mxValid || !Array.isArray(entry.mxHosts) || entry.mxHosts.length === 0) return null

  return {
    mxValid: true,
    mxHosts: entry.mxHosts,
    catchAll: entry.catchAll ?? null,
  }
}

export function updateDomainCache(
  domain: string,
  patch: Partial<Omit<DomainCacheEntry, 'updatedAt'>>
): void {
  if (!state.enabled) return
  const key = normalizeDomain(domain)
  if (!key) return

  const current = state.data.domains[key] || { updatedAt: new Date().toISOString() }
  const now = new Date().toISOString()
  const next: DomainCacheEntry = {
    ...current,
    ...patch,
    updatedAt: now,
  }

  if (patch.inferredPattern !== undefined) {
    next.patternUpdatedAt = now
  }

  if (
    patch.mxValid !== undefined ||
    patch.mxHosts !== undefined ||
    patch.catchAll !== undefined
  ) {
    next.validationUpdatedAt = now
  }

  state.data.domains[key] = next
  state.dirty = true
}

export async function flushDomainCache(): Promise<void> {
  if (!state.enabled || !state.dirty) return

  const dir = path.dirname(state.filePath)
  await mkdir(dir, { recursive: true })
  await writeFile(state.filePath, JSON.stringify(state.data, null, 2), 'utf8')
  state.dirty = false
}
