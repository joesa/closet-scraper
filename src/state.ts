import type { Pipeline, QualifiedLead } from './types.js'

const leadsByPlaceUrl = new Map<string, QualifiedLead>()
const fallbackEnteredPlaces = new Set<string>()
const fallbackFinalizedPlaces = new Set<string>()
const fallbackFinalizedWithEmailPlaces = new Set<string>()
const fallbackCaptchaPlaces = new Set<string>()

export function resetLeadState(): void {
  leadsByPlaceUrl.clear()
  fallbackEnteredPlaces.clear()
  fallbackFinalizedPlaces.clear()
  fallbackFinalizedWithEmailPlaces.clear()
  fallbackCaptchaPlaces.clear()
}

export function noteFallbackEntered(placeUrl: string): void {
  if (!placeUrl) return
  fallbackEnteredPlaces.add(placeUrl)
}

export function noteFallbackCaptcha(placeUrl: string): void {
  if (!placeUrl) return
  fallbackCaptchaPlaces.add(placeUrl)
}

export function noteFallbackFinalized(placeUrl: string, withEmail: boolean): void {
  if (!placeUrl) return
  fallbackFinalizedPlaces.add(placeUrl)
  if (withEmail) fallbackFinalizedWithEmailPlaces.add(placeUrl)
}

export function upsertLead(lead: QualifiedLead): void {
  leadsByPlaceUrl.set(lead.mapsPlaceUrl, lead)
}

export function getAllLeads(): QualifiedLead[] {
  return [...leadsByPlaceUrl.values()]
}

export function getLeadsByPipeline(pipeline: Pipeline): QualifiedLead[] {
  return getAllLeads().filter((lead) => lead.enrichment.pipeline === pipeline)
}

export function getLeadStats() {
  const all = getAllLeads()
  const pipelineA = all.filter((lead) => lead.enrichment.pipeline === 'PIPELINE_A')
  const pipelineB = all.filter((lead) => lead.enrichment.pipeline === 'PIPELINE_B')

  return {
    total: all.length,
    pipelineA: pipelineA.length,
    pipelineB: pipelineB.length,
    fallback: {
      entered: fallbackEnteredPlaces.size,
      finalized: fallbackFinalizedPlaces.size,
      finalizedWithEmail: fallbackFinalizedWithEmailPlaces.size,
      finalizedMissingEmail: fallbackFinalizedPlaces.size - fallbackFinalizedWithEmailPlaces.size,
      captchaBlocked: fallbackCaptchaPlaces.size,
      droppedBeforeFinalize: Math.max(0, fallbackEnteredPlaces.size - fallbackFinalizedPlaces.size),
    },
  }
}
