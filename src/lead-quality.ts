import type { ScraperConfig } from './config.js'
import type { RawLead } from './types.js'

const GENERIC_CATEGORY_WORDS = new Set([
  'and', 'business', 'company', 'contractor', 'contractors', 'service', 'services', 'the',
])

function cleanText(value: unknown, maxLength = 160): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

export function uniqueBusinessTerms(values: unknown[], limit = 30): string[] {
  const terms: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const term = cleanText(value)
    const key = term.toLowerCase()
    if (!term || seen.has(key)) continue
    seen.add(key)
    terms.push(term)
    if (terms.length >= limit) break
  }
  return terms
}

export function normalizeBusinessDetails(input: {
  sourceKeyword: string
  primaryCategory?: unknown
  additionalCategories?: unknown[]
  services?: unknown[]
  description?: unknown
}): Pick<RawLead,
  'businessCategory' | 'additionalCategories' | 'servicesProvided' |
  'servicesSource' | 'businessDescription'
> {
  const businessCategory = cleanText(input.primaryCategory) || null
  const additionalCategories = uniqueBusinessTerms(input.additionalCategories || [])
    .filter((category) => category.toLowerCase() !== businessCategory?.toLowerCase())
  const mapsServices = uniqueBusinessTerms(input.services || [])

  if (mapsServices.length > 0) {
    return {
      businessCategory,
      additionalCategories,
      servicesProvided: mapsServices,
      servicesSource: 'maps_services',
      businessDescription: cleanText(input.description, 1000) || null,
    }
  }

  const categoryServices = uniqueBusinessTerms([
    businessCategory,
    ...additionalCategories,
  ])
  if (categoryServices.length > 0) {
    return {
      businessCategory,
      additionalCategories,
      servicesProvided: categoryServices,
      servicesSource: 'maps_category',
      businessDescription: cleanText(input.description, 1000) || null,
    }
  }

  return {
    businessCategory,
    additionalCategories,
    servicesProvided: uniqueBusinessTerms([input.sourceKeyword]),
    servicesSource: 'search_keyword',
    businessDescription: cleanText(input.description, 1000) || null,
  }
}

function categoryTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 2 && !GENERIC_CATEGORY_WORDS.has(token))
  )
}

export function categoryMatchesLead(lead: RawLead): boolean {
  const wanted = categoryTokens(lead.sourceKeyword)
  if (wanted.size === 0) return true
  const actual = categoryTokens([
    lead.businessCategory,
    ...lead.additionalCategories,
    ...lead.servicesProvided,
  ].filter(Boolean).join(' '))
  return [...wanted].some((token) => actual.has(token))
}

export function leadFilterFailure(
  lead: RawLead,
  config: Pick<ScraperConfig,
    'noWebsiteOnly' | 'phoneRequired' | 'requireCategoryMatch' |
    'minRating' | 'minReviewCount'
  >
): string | null {
  if (config.noWebsiteOnly && lead.hasOwnWebsite) return 'has_website'
  if (config.phoneRequired && !lead.phoneNumber?.trim()) return 'missing_phone'
  if (config.minRating > 0 && (lead.ratingValue == null || lead.ratingValue < config.minRating)) {
    return 'rating_below_minimum'
  }
  if (config.minReviewCount > 0 && (lead.reviewCount == null || lead.reviewCount < config.minReviewCount)) {
    return 'reviews_below_minimum'
  }
  if (config.requireCategoryMatch && !categoryMatchesLead(lead)) return 'category_mismatch'
  return null
}
