import { describe, it, expect } from 'vitest'
import {
  isRoleBasedEmail,
  emailDomain,
  createUnsubscribeToken,
  createUnsubscribeUrl,
  parseSuppressionCsv,
} from './compliance.js'
import { campaignForPipeline } from './campaigns.js'

describe('isRoleBasedEmail', () => {
  const roles = new Set(['info', 'sales', 'support'])

  it('matches role local-parts case-insensitively', () => {
    expect(isRoleBasedEmail('INFO@acme.com', roles)).toBe(true)
    expect(isRoleBasedEmail('sales@acme.com', roles)).toBe(true)
  })

  it('does not match personal local-parts', () => {
    expect(isRoleBasedEmail('jane@acme.com', roles)).toBe(false)
  })
})

describe('emailDomain', () => {
  it('extracts and lowercases the domain', () => {
    expect(emailDomain('Jane@Acme.COM')).toBe('acme.com')
  })

  it('returns empty string when there is no domain', () => {
    expect(emailDomain('not-an-email')).toBe('')
  })
})

describe('createUnsubscribeToken', () => {
  it('is deterministic and case-insensitive on the email', () => {
    const a = createUnsubscribeToken('jane@acme.com', 'secret')
    const b = createUnsubscribeToken('JANE@ACME.COM', 'secret')
    expect(a).toBe(b)
  })

  it('changes when the secret changes and is 32 hex chars', () => {
    const a = createUnsubscribeToken('jane@acme.com', 'secret-1')
    const b = createUnsubscribeToken('jane@acme.com', 'secret-2')
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('createUnsubscribeUrl', () => {
  it('appends email + token query params to a valid base URL', () => {
    const url = createUnsubscribeUrl('https://x.com/u', 'jane@acme.com', 'tok123')
    const parsed = new URL(url)
    expect(parsed.searchParams.get('email')).toBe('jane@acme.com')
    expect(parsed.searchParams.get('token')).toBe('tok123')
  })

  it('returns empty string for empty or invalid base URLs', () => {
    expect(createUnsubscribeUrl('', 'jane@acme.com', 'tok')).toBe('')
    expect(createUnsubscribeUrl('not a url', 'jane@acme.com', 'tok')).toBe('')
  })
})

describe('parseSuppressionCsv', () => {
  it('splits on commas, trims, and drops empties', () => {
    expect(parseSuppressionCsv(' a@x.com , , b@y.com ')).toEqual(['a@x.com', 'b@y.com'])
    expect(parseSuppressionCsv('')).toEqual([])
  })
})

describe('campaignForPipeline', () => {
  it('maps PIPELINE_A and PIPELINE_B to distinct campaign blueprints', () => {
    const a = campaignForPipeline('PIPELINE_A')
    const b = campaignForPipeline('PIPELINE_B')
    expect(a).not.toBe(b)
    expect(a.sequenceKey).toBe('widget_cold_outreach')
    expect(b.sequenceKey).toBe('website_agency_upsell')
  })
})
