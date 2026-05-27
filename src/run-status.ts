import { log } from 'crawlee'

import type { ScraperConfig } from './config.js'

export async function postRunStatus(
  config: ScraperConfig,
  phase: 'started' | 'completed' | 'failed',
  runId: string | null,
  payload: Record<string, unknown>
): Promise<void> {
  const url = (config.runStatusUrl || '').trim()
  if (!url) return

  const token = (config.runStatusToken || config.controlPlaneToken || '').trim()
  if (!token) {
    log.warning('SCRAPER_RUN_STATUS_URL is set but no run-status token is configured')
    return
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(config.vercelProtectionBypassSecret
          ? {
              'x-vercel-protection-bypass': config.vercelProtectionBypassSecret,
              'x-vercel-set-bypass-cookie': 'true',
            }
          : {}),
      },
      body: JSON.stringify({
        runId,
        phase,
        payload,
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      log.warning('Run status post failed', {
        phase,
        status: response.status,
        body: text.slice(0, 300),
      })
    }
  } catch (error) {
    log.warning('Run status post threw', {
      phase,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
