import { readFile } from 'node:fs/promises'
import { createHmac } from 'node:crypto'

import type { ScraperConfig } from './config.js'

export interface ComplianceResources {
  suppressedEmails: Set<string>
  suppressedDomains: Set<string>
  roleLocalParts: Set<string>
  excludeRoleEmails: boolean
  unsubscribeBaseUrl: string
  unsubscribeSecret: string
}

const DEFAULT_ROLE_LOCAL_PARTS = [
  'info',
  'sales',
  'contact',
  'hello',
  'support',
  'admin',
  'office',
  'team',
  'marketing',
  'accounts',
  'billing',
  'jobs',
  'careers',
  'hr',
  'legal',
  'privacy',
  'webmaster',
  'postmaster',
  'abuse',
  'noreply',
  'no-reply',
  'donotreply',
]

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function normalizeDomain(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase()
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export async function loadComplianceResources(config: ScraperConfig): Promise<ComplianceResources> {
  const suppressedEmails = new Set<string>()
  const suppressedDomains = new Set<string>()

  for (const email of config.suppressionEmails) {
    suppressedEmails.add(normalizeEmail(email))
  }
  for (const domain of config.suppressionDomains) {
    suppressedDomains.add(normalizeDomain(domain))
  }

  if (config.suppressionListFile) {
    try {
      const raw = await readFile(config.suppressionListFile, 'utf8')
      const lines = raw.split(/\r?\n/)
      for (const line of lines) {
        const cleaned = line.trim()
        if (!cleaned || cleaned.startsWith('#')) continue
        if (cleaned.includes('@') && !cleaned.startsWith('@')) {
          suppressedEmails.add(normalizeEmail(cleaned))
        } else {
          suppressedDomains.add(normalizeDomain(cleaned))
        }
      }
    } catch {
      // Ignore missing/invalid suppression file and continue with in-env suppressions.
    }
  }

  const roleLocalParts = new Set<string>(DEFAULT_ROLE_LOCAL_PARTS)
  for (const entry of config.roleLocalParts) {
    roleLocalParts.add(entry.trim().toLowerCase())
  }

  return {
    suppressedEmails,
    suppressedDomains,
    roleLocalParts,
    excludeRoleEmails: config.excludeRoleEmails,
    unsubscribeBaseUrl: config.unsubscribeBaseUrl,
    unsubscribeSecret: config.unsubscribeSecret,
  }
}

export function isRoleBasedEmail(email: string, roleLocalParts: Set<string>): boolean {
  const local = email.split('@')[0]?.toLowerCase() || ''
  return roleLocalParts.has(local)
}

export function emailDomain(email: string): string {
  return email.split('@')[1]?.toLowerCase() || ''
}

export function createUnsubscribeToken(email: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(email.toLowerCase())
    .digest('hex')
    .slice(0, 32)
}

export function createUnsubscribeUrl(baseUrl: string, email: string, token: string): string {
  if (!baseUrl) return ''
  try {
    const url = new URL(baseUrl)
    url.searchParams.set('email', email)
    url.searchParams.set('token', token)
    return url.toString()
  } catch {
    return ''
  }
}

export function parseSuppressionCsv(raw: string): string[] {
  return splitCsv(raw)
}
