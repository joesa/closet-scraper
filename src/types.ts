export type Pipeline = 'PIPELINE_A' | 'PIPELINE_B'

export interface SearchSeed {
  keyword: string
  location: string
  query: string
  searchUrl: string
}

export interface PublicProfileResearch {
  sourceUrl: string
  text: string
  capturedAt: string
  captureMethod: 'public_browser'
}

export interface RawLead {
  sourceQuery: string
  sourceKeyword: string
  sourceLocation: string
  mapsPlaceUrl: string
  businessName: string | null
  businessCategory: string | null
  additionalCategories: string[]
  servicesProvided: string[]
  servicesSource: 'maps_services' | 'maps_category' | 'search_keyword'
  businessDescription: string | null
  websiteUrl: string | null
  socialProfileUrl: string | null
  /** Minimized public business prose only; no media or contact details. */
  publicProfileResearch?: PublicProfileResearch | null
  hasOwnWebsite: boolean
  phoneNumber: string | null
  address: string | null
  ratingText: string | null
  ratingValue: number | null
  reviewCount: number | null
}

export interface EnrichmentResult {
  pipeline: Pipeline
  reason:
    | 'missing_website'
    | 'contact_form_detected'
    | 'no_contact_form_detected'
    | 'contact_page_fetch_failed'
    | 'social_profile_extraction'
    | 'smtp_domain_guessing'
  contactPageUrl: string | null
  primaryEmail: string | null
  decisionMakerName: string | null
  decisionMakerTitle: string | null
  decisionMakerEmail: string | null
  decisionMakerEmailType: 'personal' | 'role' | 'unknown'
  decisionMakerEmailConfidence: number
  decisionMakerEmailSource: string
  discoveredEmails: string[]
  pagesScanned: string[]
  confidenceScore: number
  confidenceLabel: 'low' | 'medium' | 'high'
  outreachRank: 'A1' | 'A2' | 'B1' | 'B2'
}

export interface QualifiedLead extends RawLead {
  enrichment: EnrichmentResult
}

export interface WebhookDispatchSummary {
  pipeline: Pipeline
  urlConfigured: boolean
  attemptedBatches: number
  successfulBatches: number
  failedBatches: number
}
