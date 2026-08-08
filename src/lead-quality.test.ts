import { describe, expect, it } from 'vitest'

import { categoryMatchesLead, leadFilterFailure, normalizeBusinessDetails } from './lead-quality.js'
import type { RawLead } from './types.js'

function lead(overrides: Partial<RawLead> = {}): RawLead {
  return {
    sourceQuery: 'tree service Clarksville TN',
    sourceKeyword: 'tree service',
    sourceLocation: 'Clarksville TN',
    mapsPlaceUrl: 'https://google.com/maps/place/1',
    businessName: 'Acme Tree Care',
    businessCategory: 'Tree service',
    additionalCategories: ['Arborist and tree surgeon'],
    servicesProvided: ['Tree removal', 'Stump grinding'],
    servicesSource: 'maps_services',
    businessDescription: null,
    websiteUrl: null,
    socialProfileUrl: 'https://facebook.com/acmetree',
    hasOwnWebsite: false,
    phoneNumber: '931-555-0100',
    address: 'Clarksville, TN 37040',
    ratingText: '4.8 stars 42 reviews',
    ratingValue: 4.8,
    reviewCount: 42,
    ...overrides,
  }
}

describe('business detail normalization', () => {
  it('prefers Maps services and deduplicates categories', () => {
    expect(normalizeBusinessDetails({
      sourceKeyword: 'tree service',
      primaryCategory: ' Tree service ',
      additionalCategories: ['Tree service', 'Arborist', 'arborist'],
      services: ['Tree removal', ' tree removal ', 'Stump grinding'],
      description: ' Family-owned\n tree company ',
    })).toEqual({
      businessCategory: 'Tree service',
      additionalCategories: ['Arborist'],
      servicesProvided: ['Tree removal', 'Stump grinding'],
      servicesSource: 'maps_services',
      businessDescription: 'Family-owned tree company',
    })
  })

  it('falls back transparently to category and then search keyword', () => {
    expect(normalizeBusinessDetails({ sourceKeyword: 'plumber', primaryCategory: 'Plumbing service' }))
      .toMatchObject({ servicesProvided: ['Plumbing service'], servicesSource: 'maps_category' })
    expect(normalizeBusinessDetails({ sourceKeyword: 'mobile dog grooming' }))
      .toMatchObject({ servicesProvided: ['mobile dog grooming'], servicesSource: 'search_keyword' })
  })
})

describe('lead filters', () => {
  const base = {
    noWebsiteOnly: false,
    phoneRequired: false,
    requireCategoryMatch: false,
    minRating: 0,
    minReviewCount: 0,
  }

  it('distinguishes an owned website from a social profile', () => {
    expect(leadFilterFailure(lead(), { ...base, noWebsiteOnly: true })).toBeNull()
    expect(leadFilterFailure(lead({ hasOwnWebsite: true, websiteUrl: 'https://acme.com' }), {
      ...base,
      noWebsiteOnly: true,
    })).toBe('has_website')
  })

  it('enforces phone, rating, review, and category requirements', () => {
    expect(leadFilterFailure(lead({ phoneNumber: null }), { ...base, phoneRequired: true })).toBe('missing_phone')
    expect(leadFilterFailure(lead({ ratingValue: 4.2 }), { ...base, minRating: 4.5 })).toBe('rating_below_minimum')
    expect(leadFilterFailure(lead({ reviewCount: 9 }), { ...base, minReviewCount: 10 })).toBe('reviews_below_minimum')
    expect(categoryMatchesLead(lead())).toBe(true)
    expect(leadFilterFailure(lead({ businessCategory: 'Plumber', additionalCategories: [], servicesProvided: [] }), {
      ...base,
      requireCategoryMatch: true,
    })).toBe('category_mismatch')
  })
})
