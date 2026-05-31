import { log } from 'crawlee'

import type {
  Pipeline,
  QualifiedLead,
  WebhookDispatchSummary,
} from './types.js'
import { campaignForPipeline } from './campaigns.js'

interface DispatchOptions {
  batchSize: number
  authHeader: string
  authToken: string
  runId: string
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items]
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size))
  }
  return batches
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

  if (!options.authToken?.trim()) {
    log.error(
      `Webhook URL set for ${pipeline} but WEBHOOK_AUTH_TOKEN is empty — refusing to send unsigned batches`
    )
    return {
      pipeline,
      urlConfigured: true,
      attemptedBatches: 0,
      successfulBatches: 0,
      failedBatches: chunk(leads, options.batchSize).length,
    }
  }

  const batches = chunk(leads, options.batchSize)
  // Keep the on-wire webhook payload stable: positiveReply is playbook-only
  // copy (used in the exported markdown), not part of the campaign blueprint
  // the receiver consumes.
  const blueprint = campaignForPipeline(pipeline)
  const campaign = {
    name: blueprint.name,
    sequenceKey: blueprint.sequenceKey,
    followUpDelayDays: blueprint.followUpDelayDays,
    schedule: blueprint.schedule,
    safety: blueprint.safety,
    sequence: blueprint.sequence,
    ...(blueprint.smsTemplates ? { smsTemplates: blueprint.smsTemplates } : {}),
  }
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
