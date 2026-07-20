import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import {
  createUnsubscribeToken,
  createUnsubscribeUrl,
  emailDomain,
  isRoleBasedEmail,
  type ComplianceResources,
} from './compliance.js'
import { isFranchiseEmail } from './enrichment.js'
import type { QualifiedLead, SearchSeed } from './types.js'
import {
  PIPELINE_A_CAMPAIGN,
  PIPELINE_B_CAMPAIGN,
  CAMPAIGN_SCHEDULE,
  CAMPAIGN_SAFETY,
  campaignCopyHasPlaceholders,
  type CampaignBlueprint,
} from './campaigns.js'

// Vertical/industry templating (defaults preserve original custom-closet copy).
const BRAND = process.env.BRAND_NAME || 'ClosetQuote'
const BRAND_DOMAIN = process.env.BRAND_DOMAIN || 'www.closetquotes.com'
const INDUSTRY = process.env.INDUSTRY_NAME || 'custom closet'

export interface ExportArtifacts {
  runId: string
  directory: string
  jsonPath: string
  csvPath: string
  summaryPath: string
  instantlyAllCsvPath: string
  instantlyPipelineACsvPath: string
  instantlyPipelineBCsvPath: string
  instantlySuppressedCsvPath: string
  instantlyPipelineAUploadCsvPath: string
  instantlyPipelineBUploadCsvPath: string
  instantlyCampaignPlaybookPath: string
  smsOutreachCsvPath: string
  lumpyMailCsvPath: string
}

export function nowRunId(): string {
  const d = new Date()
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mi = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ''
  const raw = String(value)
  if (/[",\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`
  }
  return raw
}

function toDomain(input: string | null): string {
  if (!input) return ''
  try {
    return new URL(input).hostname.replace(/^www\./, '')
  } catch {
    return input
  }
}

function parseCity(address: string | null): string {
  if (!address) return ''
  const match = address.match(/,\s*([^,]+),\s*[A-Z]{2}\b/)
  if (match?.[1]) return match[1].trim()
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean)
  if (parts.length >= 2) return parts[parts.length - 2]
  return ''
}

function titleCase(value: string): string {
  if (!value) return ''
  return value
    .split(/\s+/)
    .map((w) => (w ? `${w[0].toUpperCase()}${w.slice(1).toLowerCase()}` : w))
    .join(' ')
}

function inferNameParts(email: string, companyName: string | null): { firstName: string; lastName: string } {
  const local = email.split('@')[0]?.toLowerCase() || ''
  const generic = new Set(['info', 'sales', 'contact', 'hello', 'support', 'admin', 'office', 'team', 'marketing'])
  const tokens = local.split(/[._-]+/).map((t) => t.trim()).filter(Boolean)

  if (tokens.length >= 2 && !generic.has(tokens[0])) {
    return {
      firstName: titleCase(tokens[0]),
      lastName: titleCase(tokens[1]),
    }
  }

  if (tokens.length === 1 && !generic.has(tokens[0])) {
    return {
      firstName: titleCase(tokens[0]),
      lastName: '',
    }
  }

  const fallback = (companyName || '').trim().split(/\s+/)[0] || ''
  return { firstName: titleCase(fallback), lastName: '' }
}

type InstantlyRow = {
  email: string
  firstName: string
  lastName: string
  decisionMakerName: string
  decisionMakerTitle: string
  decisionMakerEmail: string
  companyName: string
  website: string
  phone: string
  city: string
  rating: string
  reviewCount: string
  pipeline: string
  outreachRank: string
  reason: string
  confidenceScore: string
  emailConfidence: string
  emailSource: string
  unsubscribeToken: string
  unsubscribeUrl: string
  emailType: string
}

type SuppressedRow = {
  email: string
  companyName: string
  reason: string
  pipeline: string
  outreachRank: string
}

type InstantlyUploadRow = {
  Email: string
  'First Name': string
  'Company Name': string
  Website: string
}

type SmsOutreachRow = {
  phone: string
  companyName: string
  address: string
  hasWebsite: boolean
  suggestedSms: string
}

type LumpyMailRow = {
  companyName: string
  address: string
  city: string
  reason: string
}

// Only these truly unusable addresses are hard-suppressed from outreach.
const HARD_SUPPRESS_ROLES = new Set([
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'abuse', 'postmaster', 'webmaster',
  'mailer-daemon', 'bounces', 'unsubscribe',
])

function leadsToInstantlyRows(
  leads: QualifiedLead[],
  compliance: ComplianceResources
): { rows: InstantlyRow[]; suppressed: SuppressedRow[] } {
  const rows: InstantlyRow[] = []
  const suppressed: SuppressedRow[] = []

  for (const lead of leads) {
    const preferredEmail = lead.enrichment.decisionMakerEmail || lead.enrichment.primaryEmail
    const email = (preferredEmail || '').trim().toLowerCase()
    if (!email) {
      suppressed.push({
        email: '',
        companyName: lead.businessName || '',
        reason: 'missing_primary_email',
        pipeline: lead.enrichment.pipeline,
        outreachRank: lead.enrichment.outreachRank,
      })
      continue
    }

    if (compliance.suppressedEmails.has(email)) {
      suppressed.push({
        email,
        companyName: lead.businessName || '',
        reason: 'suppressed_email',
        pipeline: lead.enrichment.pipeline,
        outreachRank: lead.enrichment.outreachRank,
      })
      continue
    }

    const domain = emailDomain(email)
    if (domain && compliance.suppressedDomains.has(domain)) {
      suppressed.push({
        email,
        companyName: lead.businessName || '',
        reason: 'suppressed_domain',
        pipeline: lead.enrichment.pipeline,
        outreachRank: lead.enrichment.outreachRank,
      })
      continue
    }

    const isRoleMailbox = isRoleBasedEmail(email, compliance.roleLocalParts)

    // Hard-suppress only truly unusable mailboxes (noreply, postmaster, etc.)
    const localPart = email.split('@')[0] || ''
    if (HARD_SUPPRESS_ROLES.has(localPart)) {
      suppressed.push({
        email,
        companyName: lead.businessName || '',
        reason: 'hard_role_suppressed',
        pipeline: lead.enrichment.pipeline,
        outreachRank: lead.enrichment.outreachRank,
      })
      continue
    }

    // Suppress franchise/corporate emails that won't respond to cold outreach
    if (isFranchiseEmail(email)) {
      suppressed.push({
        email,
        companyName: lead.businessName || '',
        reason: 'franchise_domain_suppressed',
        pipeline: lead.enrichment.pipeline,
        outreachRank: lead.enrichment.outreachRank,
      })
      continue
    }

    const names = inferNameParts(email, lead.businessName)
    const unsubscribeToken = createUnsubscribeToken(email, compliance.unsubscribeSecret)
    const unsubscribeUrl = createUnsubscribeUrl(
      compliance.unsubscribeBaseUrl,
      email,
      unsubscribeToken
    )

    rows.push({
      email,
      firstName: names.firstName,
      lastName: names.lastName,
      decisionMakerName: lead.enrichment.decisionMakerName || '',
      decisionMakerTitle: lead.enrichment.decisionMakerTitle || '',
      decisionMakerEmail: lead.enrichment.decisionMakerEmail || '',
      companyName: lead.businessName || '',
      website: toDomain(lead.websiteUrl),
      phone: lead.phoneNumber || '',
      city: parseCity(lead.address),
      rating: lead.ratingValue != null ? String(lead.ratingValue) : '',
      reviewCount: lead.reviewCount != null ? String(lead.reviewCount) : '',
      pipeline: lead.enrichment.pipeline,
      outreachRank: lead.enrichment.outreachRank,
      reason: lead.enrichment.reason,
      confidenceScore: String(lead.enrichment.confidenceScore),
      emailConfidence: String(lead.enrichment.decisionMakerEmailConfidence || 0),
      emailSource: lead.enrichment.decisionMakerEmailSource || 'none',
      unsubscribeToken,
      unsubscribeUrl,
      emailType: lead.enrichment.decisionMakerEmailType || (isRoleMailbox ? 'role' : 'personal'),
    })
  }

  return { rows, suppressed }
}

function instantlyRowsToCsv(rows: InstantlyRow[]): string {
  const headers = [
    'email',
    'firstName',
    'lastName',
    'decisionMakerName',
    'decisionMakerTitle',
    'decisionMakerEmail',
    'companyName',
    'website',
    'phone',
    'city',
    'rating',
    'reviewCount',
    'pipeline',
    'outreachRank',
    'reason',
    'confidenceScore',
    'emailConfidence',
    'emailSource',
    'emailType',
    'unsubscribeToken',
    'unsubscribeUrl',
  ]

  const lines = [headers.join(',')]
  for (const row of rows) {
    const values = headers.map((h) => csvEscape((row as Record<string, string>)[h] || ''))
    lines.push(values.join(','))
  }

  return `${lines.join('\n')}\n`
}

function suppressedRowsToCsv(rows: SuppressedRow[]): string {
  const headers = ['email', 'companyName', 'reason', 'pipeline', 'outreachRank']
  const lines = [headers.join(',')]
  for (const row of rows) {
    const values = headers.map((h) => csvEscape((row as Record<string, string>)[h] || ''))
    lines.push(values.join(','))
  }
  return `${lines.join('\n')}\n`
}

function toInstantlyUploadRows(rows: InstantlyRow[]): InstantlyUploadRow[] {
  return rows.map((row) => ({
    Email: row.email,
    'First Name': row.firstName,
    'Company Name': row.companyName,
    Website: row.website,
  }))
}

function instantlyUploadRowsToCsv(rows: InstantlyUploadRow[]): string {
  const headers = ['Email', 'First Name', 'Company Name', 'Website']
  const lines = [headers.join(',')]
  for (const row of rows) {
    const values = headers.map((h) => csvEscape((row as Record<string, string>)[h] || ''))
    lines.push(values.join(','))
  }
  return `${lines.join('\n')}\n`
}

function buildSmsOutreachRows(leads: QualifiedLead[]): SmsOutreachRow[] {
  const rows: SmsOutreachRow[] = []

  for (const lead of leads) {
    // Only include leads that have a phone but NO usable email
    const hasEmail = !!(lead.enrichment.decisionMakerEmail || lead.enrichment.primaryEmail)
    if (hasEmail) continue
    if (!lead.phoneNumber) continue

    const companyName = lead.businessName || 'your company'
    const hasWebsite = !!(lead.websiteUrl && lead.enrichment.reason !== 'missing_website')

    let suggestedSms: string
    if (hasWebsite) {
      suggestedSms = `Hi! I\'m Joseph from ${BRAND}. I build interactive pricing calculators for ${INDUSTRY} contractors — it embeds on your site, lets homeowners get instant estimates, and texts you the lead details. Looking for a few local businesses to try it free for 30 days. Mind if I send a quick demo video?`
    } else {
      suggestedSms = `Hi! Joseph from ${BRAND} here. I noticed ${companyName} needs a website! We build bespoke, beautiful, responsive sites for ${INDUSTRY} contractors and embed our interactive pricing widget right on it to capture leads. Play with the demo at ${BRAND_DOMAIN}. Got 5 mins for a quick call to discuss?`
    }

    rows.push({
      phone: lead.phoneNumber,
      companyName: lead.businessName || '',
      address: lead.address || '',
      hasWebsite,
      suggestedSms,
    })
  }

  return rows
}

function smsOutreachRowsToCsv(rows: SmsOutreachRow[]): string {
  const headers = ['phone', 'companyName', 'address', 'hasWebsite', 'suggestedSms']
  const lines = [headers.join(',')]
  for (const row of rows) {
    const values = [
      csvEscape(row.phone),
      csvEscape(row.companyName),
      csvEscape(row.address),
      csvEscape(String(row.hasWebsite)),
      csvEscape(row.suggestedSms),
    ]
    lines.push(values.join(','))
  }
  return `${lines.join('\n')}\n`
}

function buildLumpyMailRows(leads: QualifiedLead[]): LumpyMailRow[] {
  const rows: LumpyMailRow[] = []
  for (const lead of leads) {
    const hasEmail = !!(lead.enrichment.decisionMakerEmail || lead.enrichment.primaryEmail)
    const hasPhone = !!lead.phoneNumber
    const hasAddress = !!lead.address

    if (!hasEmail && !hasPhone && hasAddress) {
      rows.push({
        companyName: lead.businessName || 'Unknown Business',
        address: lead.address || '',
        city: parseCity(lead.address),
        reason: 'No email or phone',
      })
    }
  }
  return rows
}

function lumpyMailRowsToCsv(rows: LumpyMailRow[]): string {
  const headers = ['companyName', 'address', 'city', 'reason']
  const lines = [headers.join(',')]
  for (const row of rows) {
    const values = [
      csvEscape(row.companyName),
      csvEscape(row.address),
      csvEscape(row.city),
      csvEscape(row.reason),
    ]
    lines.push(values.join(','))
  }
  return `${lines.join('\n')}\n`
}

function renderCampaignSection(
  campaign: CampaignBlueprint,
  label: string,
  uploadFile: string
): string[] {
  const lines: string[] = [
    `## Campaign ${label} Setup`,
    `- Campaign name: ${campaign.name}`,
    `- Audience file: ${uploadFile}`,
    '- Sequence steps:',
  ]
  campaign.sequence.forEach((step, i) => {
    const timing = i === 0 ? 'immediately' : `after ${step.waitDaysAfterPrevious} days if no reply`
    lines.push(`  - Step ${step.step}: Send Email ${i + 1} ${timing}`)
  })
  lines.push('')
  campaign.sequence.forEach((step, i) => {
    const heading = i === 0
      ? `### Campaign ${label} - Email ${i + 1}`
      : `### Campaign ${label} - Email ${i + 1} (${step.waitDaysAfterPrevious} days later, no reply)`
    lines.push(heading)
    lines.push(`Subject: ${step.subject}`)
    lines.push('')
    lines.push(...step.body.split('\n'))
    lines.push('')
  })
  return lines
}

function renderPositiveReply(campaign: CampaignBlueprint, label: string): string[] {
  return [
    `### ${label} Positive Reply Template`,
    'Subject: (reply in same thread)',
    '',
    ...campaign.positiveReply.body.split('\n'),
    '',
  ]
}

function buildInstantlyCampaignPlaybook(params: {
  runId: string
  pipelineACount: number
  pipelineBCount: number
  allCount: number
}): string {
  // All email/SMS copy comes from src/campaigns.ts (shared with webhooks.ts) so
  // the playbook never drifts from what the dispatcher sends.
  const days = `${CAMPAIGN_SCHEDULE.days[0].replace(/^\w/, (c) => c.toUpperCase())}-${CAMPAIGN_SCHEDULE.days[CAMPAIGN_SCHEDULE.days.length - 1].replace(/^\w/, (c) => c.toUpperCase())}`
  const fmtHour = (h: number) => `${((h + 11) % 12) + 1}:00 ${h < 12 ? 'AM' : 'PM'}`
  const sendingWindow = `${days}, ${fmtHour(CAMPAIGN_SCHEDULE.startHour)}-${fmtHour(CAMPAIGN_SCHEDULE.endHour)} (target timezone)`

  return [
    `# Instantly Campaign Playbook - Run ${params.runId}`,
    '',
    '## Upload Assets',
    '- Pipeline A upload file: instantly_pipeline_a_upload.csv',
    '- Pipeline B upload file: instantly_pipeline_b_upload.csv',
    '- Total uploadable contacts this run: ' + params.allCount,
    '- Pipeline A uploadable: ' + params.pipelineACount,
    '- Pipeline B uploadable: ' + params.pipelineBCount,
    '',
    '## Field Mapping For Upload',
    '- Email -> email address',
    '- First Name -> owner first name',
    '- Company Name -> business name',
    '- Website -> site URL (blank is acceptable for Pipeline B)',
    '',
    ...renderCampaignSection(PIPELINE_A_CAMPAIGN, 'A', 'instantly_pipeline_a_upload.csv'),
    ...renderCampaignSection(PIPELINE_B_CAMPAIGN, 'B', 'instantly_pipeline_b_upload.csv'),
    '## Positive Reply Follow-Up Templates',
    '',
    ...renderPositiveReply(PIPELINE_A_CAMPAIGN, 'Pipeline A'),
    ...renderPositiveReply(PIPELINE_B_CAMPAIGN, 'Pipeline B'),
    '## Campaign Safety Controls (both campaigns)',
    `- Daily max volume: ${CAMPAIGN_SAFETY.maxDailyPerAccount} emails/day/account`,
    `- Random delay: ${CAMPAIGN_SAFETY.minDelaySeconds}-${CAMPAIGN_SAFETY.maxDelaySeconds} seconds between emails`,
    `- Sending window: ${sendingWindow}`,
    '- Keep warmup enabled and ramp volume gradually.',
    '',
    '## Activation Checklist',
    '- [ ] Upload pipeline-specific CSV into each campaign',
    '- [ ] Confirm variable mapping for Email, First Name, Company Name, Website',
    '- [ ] Paste sequence copy and follow-up timing',
    '- [ ] Apply safety controls',
    '- [ ] Set OUTREACH_LOOM_URL / OUTREACH_LANDING_URL (no [INSERT_*] placeholders left)',
    '- [ ] Start both campaigns',
    '',
    ...(campaignCopyHasPlaceholders(PIPELINE_A_CAMPAIGN) ||
    campaignCopyHasPlaceholders(PIPELINE_B_CAMPAIGN)
      ? [
          '## WARNING',
          '- Positive-reply templates still contain [INSERT_LOOM_LINK] and/or [INSERT_LANDING_PAGE_LINK].',
          '- Set OUTREACH_LOOM_URL and OUTREACH_LANDING_URL before sending.',
          '',
        ]
      : []),
  ].join('\n')
}

function leadsToCsv(leads: QualifiedLead[]): string {
  const headers = [
    'pipeline',
    'outreachRank',
    'reason',
    'confidenceScore',
    'confidenceLabel',
    'primaryEmail',
    'decisionMakerName',
    'decisionMakerTitle',
    'decisionMakerEmail',
    'decisionMakerEmailType',
    'decisionMakerEmailConfidence',
    'decisionMakerEmailSource',
    'allEmails',
    'businessName',
    'websiteUrl',
    'phoneNumber',
    'address',
    'ratingText',
    'mapsPlaceUrl',
    'sourceKeyword',
    'sourceLocation',
    'sourceQuery',
    'contactPageUrl',
    'pagesScannedCount',
    'pagesScanned',
  ]

  const lines = [headers.join(',')]
  for (const lead of leads) {
    const row = [
      lead.enrichment.pipeline,
      lead.enrichment.outreachRank,
      lead.enrichment.reason,
      lead.enrichment.confidenceScore,
      lead.enrichment.confidenceLabel,
      lead.enrichment.primaryEmail,
      lead.enrichment.decisionMakerName,
      lead.enrichment.decisionMakerTitle,
      lead.enrichment.decisionMakerEmail,
      lead.enrichment.decisionMakerEmailType,
      lead.enrichment.decisionMakerEmailConfidence,
      lead.enrichment.decisionMakerEmailSource,
      lead.enrichment.discoveredEmails.join(';'),
      lead.businessName,
      lead.websiteUrl,
      lead.phoneNumber,
      lead.address,
      lead.ratingText,
      lead.mapsPlaceUrl,
      lead.sourceKeyword,
      lead.sourceLocation,
      lead.sourceQuery,
      lead.enrichment.contactPageUrl,
      lead.enrichment.pagesScanned.length,
      lead.enrichment.pagesScanned.join(';'),
    ].map(csvEscape)
    lines.push(row.join(','))
  }

  return `${lines.join('\n')}\n`
}

// Stable dedup key for a lead across runs: prefer the discovered email, then
// the website domain, then the Maps place URL.
function leadDedupKey(lead: QualifiedLead): string {
  const email = lead.enrichment?.primaryEmail?.toLowerCase().trim()
  if (email) return `email:${email}`
  const site = toDomain(lead.websiteUrl).toLowerCase()
  if (site) return `site:${site}`
  return `place:${lead.mapsPlaceUrl}`
}

/**
 * Aggregate every `leads.json` under `exports/run-<id>` produced by a per-city
 * loop into a single deduped dataset under `exports/combined`. Returns null when
 * there are no run exports to merge.
 */
export async function mergeRunExports(): Promise<
  { combinedDir: string; runCount: number; leadCount: number } | null
> {
  const exportsRoot = path.join(process.cwd(), 'exports')

  let entries: string[]
  try {
    entries = await readdir(exportsRoot)
  } catch {
    return null
  }

  const runDirs = entries.filter((name) => name.startsWith('run-')).sort()
  if (runDirs.length === 0) return null

  const seen = new Set<string>()
  const merged: QualifiedLead[] = []

  for (const dir of runDirs) {
    const jsonPath = path.join(exportsRoot, dir, 'leads.json')
    let parsed: { leads?: QualifiedLead[] }
    try {
      parsed = JSON.parse(await readFile(jsonPath, 'utf8'))
    } catch {
      continue
    }
    const leads = Array.isArray(parsed.leads) ? parsed.leads : []
    for (const lead of leads) {
      const key = leadDedupKey(lead)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(lead)
    }
  }

  const combinedDir = path.join(exportsRoot, 'combined')
  await mkdir(combinedDir, { recursive: true })

  await writeFile(
    path.join(combinedDir, 'leads.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        runCount: runDirs.length,
        leadCount: merged.length,
        leads: merged,
      },
      null,
      2
    ),
    'utf8'
  )
  await writeFile(path.join(combinedDir, 'leads.csv'), leadsToCsv(merged), 'utf8')

  return { combinedDir, runCount: runDirs.length, leadCount: merged.length }
}

export async function writeRunArtifacts(params: {
  runId?: string
  seeds: SearchSeed[]
  leads: QualifiedLead[]
  stats: { total: number; pipelineA: number; pipelineB: number }
  compliance: ComplianceResources
}): Promise<ExportArtifacts> {
  const runId = params.runId ?? nowRunId()
  const directory = path.join(process.cwd(), 'exports', `run-${runId}`)
  await mkdir(directory, { recursive: true })

  const jsonPath = path.join(directory, 'leads.json')
  const csvPath = path.join(directory, 'leads.csv')
  const summaryPath = path.join(directory, 'summary.json')
  const instantlyAllCsvPath = path.join(directory, 'instantly_all.csv')
  const instantlyPipelineACsvPath = path.join(directory, 'instantly_pipeline_a.csv')
  const instantlyPipelineBCsvPath = path.join(directory, 'instantly_pipeline_b.csv')
  const instantlySuppressedCsvPath = path.join(directory, 'instantly_suppressed.csv')
  const instantlyPipelineAUploadCsvPath = path.join(directory, 'instantly_pipeline_a_upload.csv')
  const instantlyPipelineBUploadCsvPath = path.join(directory, 'instantly_pipeline_b_upload.csv')
  const instantlyCampaignPlaybookPath = path.join(directory, 'instantly_campaign_playbook.md')
  const smsOutreachCsvPath = path.join(directory, 'sms_outreach.csv')
  const lumpyMailCsvPath = path.join(directory, 'lumpy_mail.csv')

  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        runId,
        generatedAt: new Date().toISOString(),
        seedCount: params.seeds.length,
        seeds: params.seeds,
        leadCount: params.leads.length,
        leads: params.leads,
      },
      null,
      2
    ),
    'utf8'
  )

  await writeFile(csvPath, leadsToCsv(params.leads), 'utf8')

  const { rows: instantlyAllRows, suppressed: suppressedRows } = leadsToInstantlyRows(
    params.leads,
    params.compliance
  )
  const instantlyPipelineARows = instantlyAllRows.filter((r) => r.pipeline === 'PIPELINE_A')
  const instantlyPipelineBRows = instantlyAllRows.filter((r) => r.pipeline === 'PIPELINE_B')
  const instantlyPipelineAUploadRows = toInstantlyUploadRows(instantlyPipelineARows)
  const instantlyPipelineBUploadRows = toInstantlyUploadRows(instantlyPipelineBRows)

  const smsOutreachRows = buildSmsOutreachRows(params.leads)
  const lumpyMailRows = buildLumpyMailRows(params.leads)

  await writeFile(instantlyAllCsvPath, instantlyRowsToCsv(instantlyAllRows), 'utf8')
  await writeFile(instantlyPipelineACsvPath, instantlyRowsToCsv(instantlyPipelineARows), 'utf8')
  await writeFile(instantlyPipelineBCsvPath, instantlyRowsToCsv(instantlyPipelineBRows), 'utf8')
  await writeFile(instantlySuppressedCsvPath, suppressedRowsToCsv(suppressedRows), 'utf8')
  await writeFile(instantlyPipelineAUploadCsvPath, instantlyUploadRowsToCsv(instantlyPipelineAUploadRows), 'utf8')
  await writeFile(instantlyPipelineBUploadCsvPath, instantlyUploadRowsToCsv(instantlyPipelineBUploadRows), 'utf8')
  await writeFile(smsOutreachCsvPath, smsOutreachRowsToCsv(smsOutreachRows), 'utf8')
  await writeFile(lumpyMailCsvPath, lumpyMailRowsToCsv(lumpyMailRows), 'utf8')
  await writeFile(
    instantlyCampaignPlaybookPath,
    buildInstantlyCampaignPlaybook({
      runId,
      pipelineACount: instantlyPipelineAUploadRows.length,
      pipelineBCount: instantlyPipelineBUploadRows.length,
      allCount: instantlyPipelineAUploadRows.length + instantlyPipelineBUploadRows.length,
    }),
    'utf8'
  )

  await writeFile(
    summaryPath,
    JSON.stringify(
      {
        runId,
        generatedAt: new Date().toISOString(),
        seedCount: params.seeds.length,
        leadCount: params.leads.length,
        instantlyRowCount: instantlyAllRows.length,
        instantlyPipelineARowCount: instantlyPipelineARows.length,
        instantlyPipelineBRowCount: instantlyPipelineBRows.length,
        instantlySuppressedRowCount: suppressedRows.length,
        smsOutreachRowCount: smsOutreachRows.length,
        lumpyMailRowCount: lumpyMailRows.length,
        stats: params.stats,
      },
      null,
      2
    ),
    'utf8'
  )

  return {
    runId,
    directory,
    jsonPath,
    csvPath,
    summaryPath,
    instantlyAllCsvPath,
    instantlyPipelineACsvPath,
    instantlyPipelineBCsvPath,
    instantlySuppressedCsvPath,
    instantlyPipelineAUploadCsvPath,
    instantlyPipelineBUploadCsvPath,
    instantlyCampaignPlaybookPath,
    smsOutreachCsvPath,
    lumpyMailCsvPath,
  }
}
