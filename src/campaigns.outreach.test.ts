import { describe, it, expect } from 'vitest'
import {
  PIPELINE_A_CAMPAIGN,
  PIPELINE_B_CAMPAIGN,
  campaignCopyHasPlaceholders,
  OUTREACH_LANDING_URL,
} from './campaigns.js'

describe('campaign outreach links', () => {
  it('defaults landing URL so Pipeline B positive-reply has no landing placeholder', () => {
    expect(OUTREACH_LANDING_URL).toBeTruthy()
    expect(PIPELINE_B_CAMPAIGN.positiveReply.body).not.toContain('[INSERT_LANDING_PAGE_LINK]')
  })

  it('reports placeholders when Loom URL is unset at module load', () => {
    // OUTREACH_LOOM_URL is empty by default in tests → Loom placeholder remains.
    if (!(process.env.OUTREACH_LOOM_URL || '').trim()) {
      expect(campaignCopyHasPlaceholders(PIPELINE_A_CAMPAIGN)).toBe(true)
      expect(PIPELINE_A_CAMPAIGN.positiveReply.body).toContain('[INSERT_LOOM_LINK]')
    } else {
      expect(campaignCopyHasPlaceholders(PIPELINE_A_CAMPAIGN)).toBe(false)
    }
  })
})
