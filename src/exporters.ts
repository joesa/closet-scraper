import { mkdir, writeFile } from 'node:fs/promises'
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
      suggestedSms = `Hi! I\'m Joseph from ClosetQuote. I build interactive pricing calculators for custom closet contractors — it embeds on your site, lets homeowners get instant estimates, and texts you the lead details. Looking for a few local businesses to try it free for 30 days. Mind if I send a quick demo video?`
    } else {
      suggestedSms = `Hi! Joseph from ClosetQuote here. I noticed ${companyName} needs a website! We build bespoke, beautiful, responsive sites for closet contractors and embed our interactive pricing widget right on it to capture leads. Play with the demo at www.closetquotes.com. Got 5 mins for a quick call to discuss?`
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

function buildInstantlyCampaignPlaybook(params: {
  runId: string
  pipelineACount: number
  pipelineBCount: number
  allCount: number
}): string {
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
    '## Campaign A Setup',
    '- Campaign name: ClosetQuote - Widget Cold Outreach',
    '- Audience file: instantly_pipeline_a_upload.csv',
    '- Sequence steps:',
    '  - Step 1: Send Email 1 immediately',
    '  - Step 2: Send Email 2 after 3 days if no reply',
    '',
    '### Campaign A - Email 1',
    'Subject: Quick idea for {Company Name}\'s website',
    '',
    'Hi {First Name},',
    '',
    'I am a software builder with 20+ years of experience here in the Nashville, TN. I was looking at your site ({Website}) and noticed you\'re relying on a standard contact form to capture incoming customer inquiries.',
    '',
    'I recently built an interactive pricing calculator designed specifically for custom storage and closet contractors. It embeds right onto your existing site, allows homeowners to get an instant anchored price range based on their linear footage and finishes, and immediately texts the full lead details directly to your phone.',
    '',
    'I\'m looking for a few local businesses in your area to test it out completely free for 30 days. No credit card required. Mind if I send over a quick 60-second video showing how it works?',
    '',
    'Best,',
    'Joseph Sintim-Amoah',
    'Founder, ClosetQuote',
    '',
    '### Campaign A - Email 2 (3 days later, no reply)',
    'Subject: Re: Quick idea for {Company Name}\'s website',
    '',
    'Hi {First Name},',
    '',
    'I know you\'re busy running projects, so I\'ll keep this brief.',
    '',
    'I set up a public sandbox demo on our landing page where you can play with the calculator yourself to see how it looks on mobile.',
    '',
    'Let me know if you\'d be open to checking out the link.',
    '',
    'Thanks,',
    'Joseph',
    '',
    '## Campaign B Setup',
    '- Campaign name: ClosetQuote - Website Agency Upsell',
    '- Audience file: instantly_pipeline_b_upload.csv',
    '- Sequence steps:',
    '  - Step 1: Send Email 1 immediately',
    '  - Step 2: Send Email 2 after 4 days if no reply',
    '',
    '### Campaign B - Email 1',
    'Subject: Modern web design + lead engine for {Company Name}',
    '',
    'Hi {First Name},',
    '',
    'I was looking for local custom storage contractors online and noticed that {Company Name} does not have an active website set up yet. In this space, missing a digital portfolio means losing high-end jobs to competitors who show off their work online.',
    '',
    'I build premium, lightning-fast showcase sites specifically for independent contractors. My builds come pre-loaded with an interactive pricing widget that gives homeowners instant estimates and texts their contact info, room measurements, and material selections straight to your cell phone.',
    '',
    'I\'m looking to build a local case study this month and can handle the entire design, hosting setup, and widget integration for a flat, one-time fee.',
    '',
    'Would you be open to seeing a quick mockup layout of what I could put together for {Company Name}?',
    '',
    'Best,',
    'Joseph Sintim-Amoah',
    'Founder, ClosetQuote',
    '',
    '### Campaign B - Email 2 (4 days later, no reply)',
    'Subject: Re: Modern web design + lead engine for {Company Name}',
    '',
    '{First Name},',
    '',
    'Just following up on this. I put together a generic sandbox demo of the pricing engine so you can see the exact tool that would be built natively into your new site.',
    '',
    'If you want to check it out or jump on a quick 5-minute call to talk about getting an online gallery set up for {Company Name}, let me know what day works best for you.',
    '',
    'Best,',
    'Joseph',
    '',
    '## Positive Reply Follow-Up Templates',
    '',
    '### Pipeline A Positive Reply Template',
    'Subject: (reply in same thread)',
    '',
    'Awesome, appreciate you getting back to me, {First Name}.',
    '',
    'Here is the 60-second video showing exactly how it embeds on a site and texts you the lead: [INSERT_LOOM_LINK]',
    '',
    'You can also play with a live sandbox version on your phone right here to see exactly what your customers would see: [INSERT_LANDING_PAGE_LINK]',
    '',
    'If you want to drop this on your site today, you can grab your 30-day free beta account here (no credit card required). Just let me know if you want me to help you configure your specific room pricing matrix.',
    '',
    'Best,',
    'Joseph',
    '',
    '### Pipeline B Positive Reply Template',
    'Subject: (reply in same thread)',
    '',
    'Great to connect, {First Name}.',
    '',
    'Before we talk layouts and design, I want to show you the actual lead-capture engine that comes built natively into the sites I make.',
    '',
    'You can test drive a live sandbox of the calculator here: [INSERT_LANDING_PAGE_LINK]',
    '',
    'Imagine a homeowner landing on your new digital portfolio, playing with that widget, and their exact measurements and contact info immediately buzzing your cell phone.',
    '',
    'I\'d love to throw together a quick, custom layout mockup for {Company Name} so you can see what it looks like with your branding. Are you around for a quick 10-minute call this Tuesday or Wednesday to talk about the style you\'re looking for?',
    '',
    'Best,',
    'Joseph',
    '',
    '## Campaign Safety Controls (both campaigns)',
    '- Daily max volume: 20 emails/day/account',
    '- Random delay: 300-600 seconds between emails',
    '- Sending window: Monday-Friday, 9:00 AM-5:00 PM (target timezone)',
    '- Keep warmup enabled and ramp volume gradually.',
    '',
    '## Activation Checklist',
    '- [ ] Upload pipeline-specific CSV into each campaign',
    '- [ ] Confirm variable mapping for Email, First Name, Company Name, Website',
    '- [ ] Paste sequence copy and follow-up timing',
    '- [ ] Apply safety controls',
    '- [ ] Insert Loom and landing page links in positive-reply templates',
    '- [ ] Start both campaigns',
    '',
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
