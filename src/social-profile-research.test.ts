import { describe, expect, it } from 'vitest'

import {
  buildPublicProfileResearch,
  publicProfileAboutUrl,
  withoutPublicProfileResearch,
} from './social-profile-research.js'

const BUSINESS_TEXT = `Peerless Pressure & SoftWash
Professional pressure washing services for homes, driveways, sidewalks, fences, patios and more.
We use soft washing for siding affected by algae and mildew in Clarksville.
House washing and concrete cleaning estimates are available.`

describe('buildPublicProfileResearch', () => {
  it('keeps bounded public business prose and exact provenance', () => {
    const result = buildPublicProfileResearch({
      requestedUrl: 'https://www.facebook.com/61590230650878/',
      loadedUrl: 'https://www.facebook.com/61590230650878/about',
      bodyText: BUSINESS_TEXT,
      capturedAt: '2026-08-09T00:00:00.000Z',
    })

    expect(result.research).toMatchObject({
      sourceUrl: 'https://www.facebook.com/61590230650878/',
      captureMethod: 'public_browser',
      capturedAt: '2026-08-09T00:00:00.000Z',
    })
    expect(result.research?.text).toContain('We use soft washing')
  })

  it('redacts contact details and removes duplicate browser chrome', () => {
    const result = buildPublicProfileResearch({
      requestedUrl: 'https://www.facebook.com/peerless/',
      loadedUrl: 'https://www.facebook.com/peerless/about',
      bodyText: `${BUSINESS_TEXT}\nHome\nHome\nCall +1 (931) 555-0199 or owner@example.com`,
    })

    expect(result.research?.text).not.toContain('555-0199')
    expect(result.research?.text).not.toContain('owner@example.com')
    expect(result.research?.text.match(/^Home$/gm)).toBeNull()
  })

  it('accepts a public Yelp business page with exact provenance', () => {
    const result = buildPublicProfileResearch({
      requestedUrl: 'https://www.yelp.com/biz/peerless-pressure-softwash-clarksville',
      loadedUrl: 'https://www.yelp.com/biz/peerless-pressure-softwash-clarksville?sort_by=date_desc',
      bodyText: BUSINESS_TEXT,
    })

    expect(result.research).toMatchObject({
      sourceUrl: 'https://www.yelp.com/biz/peerless-pressure-softwash-clarksville',
      captureMethod: 'public_browser',
    })
  })

  it('drops Yelp customer reviews before evidence leaves the browser', () => {
    const result = buildPublicProfileResearch({
      requestedUrl: 'https://www.yelp.com/biz/peerless-pressure-softwash-clarksville',
      loadedUrl: 'https://www.yelp.com/biz/peerless-pressure-softwash-clarksville',
      bodyText: `${BUSINESS_TEXT}\nRecommended Reviews\nA customer said this was the best service ever.`,
    })

    expect(result.research?.text).toContain('We use soft washing')
    expect(result.research?.text).not.toContain('A customer said')
  })

  it.each(['Reviews (14)', 'Review Highlights', 'Ask the Community']) (
    'stops browser evidence at Yelp section variant %s',
    (heading) => {
      const result = buildPublicProfileResearch({
        requestedUrl: 'https://www.yelp.com/biz/peerless-pressure-softwash-clarksville',
        loadedUrl: 'https://www.yelp.com/biz/peerless-pressure-softwash-clarksville',
        bodyText: `${BUSINESS_TEXT}\n${heading}\nCustomer prose`,
      })
      expect(result.research?.text).not.toContain('Customer prose')
    }
  )

  it.each([
    ['login redirect', 'https://www.facebook.com/login/', BUSINESS_TEXT],
    ['checkpoint redirect', 'https://www.facebook.com/checkpoint/123', BUSINESS_TEXT],
    ['private page', 'https://www.instagram.com/peerless/', `${BUSINESS_TEXT}\nThis account is private`],
    ['cross-platform redirect', 'https://www.instagram.com/peerless/', BUSINESS_TEXT],
    ['Yelp challenge', 'https://www.yelp.com/challenge', BUSINESS_TEXT],
  ])('rejects %s', (_label, loadedUrl, bodyText) => {
    const result = buildPublicProfileResearch({
      requestedUrl: 'https://www.facebook.com/peerless/',
      loadedUrl,
      bodyText,
    })
    expect(result.research).toBeNull()
  })

  it('rejects non-business Yelp pages and cross-platform redirects', () => {
    expect(
      buildPublicProfileResearch({
        requestedUrl: 'https://www.yelp.com/search?find_desc=pressure+washing',
        loadedUrl: 'https://www.yelp.com/search?find_desc=pressure+washing',
        bodyText: BUSINESS_TEXT,
      }).research
    ).toBeNull()
    expect(
      buildPublicProfileResearch({
        requestedUrl: 'https://www.facebook.com/peerless/',
        loadedUrl: 'https://www.yelp.com/biz/peerless-pressure-softwash-clarksville',
        bodyText: BUSINESS_TEXT,
      }).research
    ).toBeNull()
  })

  it('rejects insecure, unsupported, and thin sources', () => {
    expect(
      buildPublicProfileResearch({
        requestedUrl: 'http://facebook.com/peerless',
        loadedUrl: 'http://facebook.com/peerless',
        bodyText: BUSINESS_TEXT,
      }).research
    ).toBeNull()
    expect(
      buildPublicProfileResearch({
        requestedUrl: 'https://example.com/peerless',
        loadedUrl: 'https://example.com/peerless',
        bodyText: BUSINESS_TEXT,
      }).research
    ).toBeNull()
    expect(
      buildPublicProfileResearch({
        requestedUrl: 'https://www.facebook.com/peerless',
        loadedUrl: 'https://www.facebook.com/peerless',
        bodyText: 'Peerless Pressure Washing',
      }).research
    ).toBeNull()
  })
})

describe('publicProfileAboutUrl', () => {
  it('preserves numeric profile identity', () => {
    expect(
      publicProfileAboutUrl('https://www.facebook.com/profile.php?id=61590230650878')
    ).toBe('https://www.facebook.com/profile.php?id=61590230650878&sk=about')
  })

  it('uses public About pages for vanity URLs and leaves Instagram unchanged', () => {
    expect(publicProfileAboutUrl('https://www.facebook.com/peerless/')).toBe(
      'https://www.facebook.com/peerless/about'
    )
    expect(publicProfileAboutUrl('https://www.instagram.com/peerless/')).toBe(
      'https://www.instagram.com/peerless/'
    )
  })
})

describe('withoutPublicProfileResearch', () => {
  it('removes temporary prose from generic durable outputs', () => {
    const lead = {
      businessName: 'Peerless',
      publicProfileResearch: { text: BUSINESS_TEXT },
    }
    expect(withoutPublicProfileResearch(lead)).toEqual({ businessName: 'Peerless' })
  })
})