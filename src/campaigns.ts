import type { Pipeline } from './types.js'

/**
 * Single source of truth for outbound campaign copy and settings.
 *
 * Both the webhook dispatcher (src/webhooks.ts, which sends campaign blueprints
 * to the Instantly receiver) and the export-time playbook generator
 * (src/exporters.ts, which writes instantly_campaign_playbook.md) consume these
 * definitions so the email/SMS copy never drifts between the two.
 */

export type CampaignSequenceStep = {
  step: number
  waitDaysAfterPrevious: number
  subject: string
  body: string
}

export type SmsTemplate = {
  step: number
  delayDays: number
  body: string
}

export type PositiveReplyTemplate = {
  body: string
}

export type CampaignSchedule = {
  timezone: string
  days: string[]
  startHour: number
  endHour: number
}

export type CampaignSafety = {
  maxDailyPerAccount: number
  minDelaySeconds: number
  maxDelaySeconds: number
}

export type CampaignBlueprint = {
  name: string
  sequenceKey: 'widget_cold_outreach' | 'website_agency_upsell'
  followUpDelayDays: number
  schedule: CampaignSchedule
  safety: CampaignSafety
  sequence: CampaignSequenceStep[]
  smsTemplates?: SmsTemplate[]
  positiveReply: PositiveReplyTemplate
}

// Shared sending window + safety controls (identical for both campaigns).
export const CAMPAIGN_SCHEDULE: CampaignSchedule = {
  timezone: 'America/Chicago',
  days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  startHour: 9,
  endHour: 17,
}

export const CAMPAIGN_SAFETY: CampaignSafety = {
  maxDailyPerAccount: 20,
  minDelaySeconds: 300,
  maxDelaySeconds: 600,
}

export const PIPELINE_A_CAMPAIGN: CampaignBlueprint = {
  name: 'ClosetQuote - Widget Cold Outreach',
  sequenceKey: 'widget_cold_outreach',
  followUpDelayDays: 3,
  schedule: CAMPAIGN_SCHEDULE,
  safety: CAMPAIGN_SAFETY,
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
  positiveReply: {
    body:
      "Awesome, appreciate you getting back to me, {First Name}.\n\nHere is the 60-second video showing exactly how it embeds on a site and texts you the lead: [INSERT_LOOM_LINK]\n\nYou can also play with a live sandbox version on your phone right here to see exactly what your customers would see: [INSERT_LANDING_PAGE_LINK]\n\nIf you want to drop this on your site today, you can grab your 30-day free beta account here (no credit card required). Just let me know if you want me to help you configure your specific room pricing matrix.\n\nBest,\nJoseph",
  },
}

export const PIPELINE_B_CAMPAIGN: CampaignBlueprint = {
  name: 'ClosetQuote - Website Agency Upsell',
  sequenceKey: 'website_agency_upsell',
  followUpDelayDays: 4,
  schedule: CAMPAIGN_SCHEDULE,
  safety: CAMPAIGN_SAFETY,
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
  positiveReply: {
    body:
      "Great to connect, {First Name}.\n\nBefore we talk layouts and design, I want to show you the actual lead-capture engine that comes built natively into the sites I make.\n\nYou can test drive a live sandbox of the calculator here: [INSERT_LANDING_PAGE_LINK]\n\nImagine a homeowner landing on your new digital portfolio, playing with that widget, and their exact measurements and contact info immediately buzzing your cell phone.\n\nI'd love to throw together a quick, custom layout mockup for {Company Name} so you can see what it looks like with your branding. Are you around for a quick 10-minute call this Tuesday or Wednesday to talk about the style you're looking for?\n\nBest,\nJoseph",
  },
}

export function campaignForPipeline(pipeline: Pipeline): CampaignBlueprint {
  return pipeline === 'PIPELINE_A' ? PIPELINE_A_CAMPAIGN : PIPELINE_B_CAMPAIGN
}
