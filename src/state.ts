import type { Pipeline, QualifiedLead } from './types.js'

const leadsByPlaceUrl = new Map<string, QualifiedLead>()

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
  }
}
