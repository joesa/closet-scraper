import { log } from 'crawlee'

import type {
  Pipeline,
  QualifiedLead,
  WebhookDispatchSummary,
} from './types.js'

interface DispatchOptions {
  batchSize: number
  authHeader: string
  authToken: string
  runId: string
}

type CampaignSequenceStep = {
  step: number
  waitDaysAfterPrevious: number
  subject: string
  body: string
}

type SmsTemplate = {
  step: number
  delayDays: number
  body: string
}

type CampaignBlueprint = {
  name: string
  sequenceKey: 'widget_cold_outreach' | 'website_agency_upsell'
  followUpDelayDays: number
  schedule: {
    timezone: string
    days: string[]
    startHour: number
    endHour: number
  }
  safety: {
    maxDailyPerAccount: number
    minDelaySeconds: number
    maxDelaySeconds: number
  }
  sequence: CampaignSequenceStep[]
  smsTemplates?: SmsTemplate[]
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items]
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size))
  }
  return batches
}

function campaignForPipeline(pipeline: Pipeline): CampaignBlueprint {
  if (pipeline === 'PIPELINE_A') {
    return {
      name: 'ClosetQuote - Widget Cold Outreach',
      sequenceKey: 'widget_cold_outreach',
      followUpDelayDays: 3,
      schedule: {
        timezone: 'America/Chicago',
        days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        startHour: 9,
        endHour: 17,
      },
      safety: {
        maxDailyPerAccount: 20,
        minDelaySeconds: 300,
        maxDelaySeconds: 600,
      },
      sequence: [
        {
          step: 1,
          waitDaysAfterPrevious: 0,
          subject: "Quick idea for {Company Name}'s website",
          body:
            "Hi {First Name},\n\nI am a software builder with 20+ years of experience here in the Nashville, TN. I was looking at your site ({Website}) and noticed you're relying on a standard contact form to capture incoming customer inquiries.\n\nI recently built an interactive pricing calculator designed specifically for custom storage and closet contractors. It embeds right onto your existing site, allows homeowners to get an instant anchored price range based on their linear footage and finishes, and immediately texts the full lead details directly to your phone.\n\nI'm looking for a few local businesses in your area to test it out completely free for 30 days. No credit card required. Mind if I send over a quick 60-second video showing how it works?\n\nBest,\nJoseph Sintim-Amoah\nFounder, ClosetQuote",
        },
        {
          step: 2,
          waitDaysAfterPrevious: 3,
          subject: "Re: Quick idea for {Company Name}'s website",
          body:
            "Hi {First Name},\n\nI know you're busy running projects, so I'll keep this brief.\n\nI set up a public sandbox demo on our landing page where you can play with the calculator yourself to see how it looks on mobile.\n\nLet me know if you'd be open to checking out the link.\n\nThanks,\nJoseph",
        },
      ],
    }
  }

  return {
    name: 'ClosetQuote - Website Agency Upsell',
    sequenceKey: 'website_agency_upsell',
    followUpDelayDays: 4,
    schedule: {
      timezone: 'America/Chicago',
      days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      startHour: 9,
      endHour: 17,
    },
    safety: {
      maxDailyPerAccount: 20,
      minDelaySeconds: 300,
      maxDelaySeconds: 600,
    },
    sequence: [
      {
        step: 1,
        waitDaysAfterPrevious: 0,
        subject: 'Modern web design + lead engine for {Company Name}',
        body:
          "Hi {First Name},\n\nI was looking for local custom storage contractors online and noticed that {Company Name} does not have an active website set up yet. In this space, missing a digital portfolio means losing high-end jobs to competitors who show off their work online.\n\nI build premium, lightning-fast showcase sites specifically for independent contractors. My builds come pre-loaded with an interactive pricing widget that gives homeowners instant estimates and texts their contact info, room measurements, and material selections straight to your cell phone.\n\nI'm looking to build a local case study this month and can handle the entire design, hosting setup, and widget integration for a flat, one-time fee.\n\nWould you be open to seeing a quick mockup layout of what I could put together for {Company Name}?\n\nBest,\nJoseph Sintim-Amoah\nFounder, ClosetQuote",
      },
      {
        step: 2,
        waitDaysAfterPrevious: 4,
        subject: 'Re: Modern web design + lead engine for {Company Name}',
        body:
          '{First Name},\n\nJust following up on this. I put together a generic sandbox demo of the pricing engine so you can see the exact tool that would be built natively into your new site.\n\nIf you want to check it out or jump on a quick 5-minute call to talk about getting an online gallery set up for {Company Name}, let me know what day works best for you.\n\nBest,\nJoseph',
      },
    ],
    smsTemplates: [
      {
        step: 1,
        delayDays: 0,
        body: `Hi! I found {businessName} on Google Maps while searching for closet contractors in {city}. Noticed you don't have a website yet — I build premium sites for contractors that come with a built-in quote calculator. It texts leads straight to your phone. Want to see a 60-sec demo? - Joseph, ClosetQuote`,
      },
      {
        step: 2,
        delayDays: 2,
        body: `Hey, just following up about {businessName}. I've got a live demo you can try right now at closetquotes.com — most contractors see their first lead within 48 hours of going live. Want me to mock up a free design for your business? - Joseph`,
      },
    ],
  }
}

export async function dispatchToWebhook(
  pipeline: Pipeline,
  webhookUrl: string,
  leads: QualifiedLead[],
  options: DispatchOptions
): Promise<WebhookDispatchSummary> {
  if (!webhookUrl) {
    log.warning(`No webhook configured for ${pipeline}; skipping dispatch`)
    return {
      pipeline,
      urlConfigured: false,
      attemptedBatches: 0,
      successfulBatches: 0,
      failedBatches: 0,
    }
  }

  const batches = chunk(leads, options.batchSize)
  const campaign = campaignForPipeline(pipeline)
  let successfulBatches = 0
  let failedBatches = 0

  for (const [index, batch] of batches.entries()) {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }

      if (options.authToken) {
        headers[options.authHeader] = options.authToken
      }

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          runId: options.runId,
          idempotencyKey: `${options.runId}:${pipeline}:${index + 1}`,
          pipeline,
          campaign,
          count: batch.length,
          batchIndex: index + 1,
          totalBatches: batches.length,
          leads: batch,
        }),
      })

      if (!response.ok) {
        failedBatches += 1
        const errText = await response.text()
        log.error(`Webhook ${pipeline} batch ${index + 1} failed`, {
          status: response.status,
          body: errText.slice(0, 500),
        })
        continue
      }

      successfulBatches += 1
      log.info(`Webhook ${pipeline} batch ${index + 1}/${batches.length} sent`, {
        leadCount: batch.length,
      })
    } catch (err) {
      failedBatches += 1
      log.error(`Webhook ${pipeline} batch ${index + 1} threw`, {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    pipeline,
    urlConfigured: true,
    attemptedBatches: batches.length,
    successfulBatches,
    failedBatches,
  }
}
