import { describe, expect, it } from 'vitest'

import { buildSearchSeeds, type ScraperConfig } from './config.js'

describe('search seed generation', () => {
  it('accepts ZIP/state location strings and adds an optional radius', () => {
    const config = {
      mapsKeywords: ['tree service'],
      targetLocations: ['37040 Clarksville TN'],
      searchRadiusMiles: 25,
    } as ScraperConfig
    const [seed] = buildSearchSeeds(config)
    expect(seed.query).toBe('tree service within 25 miles of 37040 Clarksville TN')
    expect(decodeURIComponent(seed.searchUrl)).toContain(seed.query)
  })

  it('preserves the existing query shape when radius is disabled', () => {
    const config = {
      mapsKeywords: ['plumber'],
      targetLocations: ['Nashville TN'],
      searchRadiusMiles: 0,
    } as ScraperConfig
    expect(buildSearchSeeds(config)[0].query).toBe('plumber Nashville TN')
  })
})
