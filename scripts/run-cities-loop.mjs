#!/usr/bin/env node
import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'

function splitCsv(value) {
  if (!value) return []
  return value.split(',').map((s) => s.trim()).filter(Boolean)
}

function toInt(value, fallback) {
  const n = Number.parseInt(value || '', 10)
  return Number.isFinite(n) ? n : fallback
}

function toBool(value, fallback) {
  if (value == null || value === '') return fallback
  return String(value).toLowerCase() === 'true'
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath)
  mkdirSync(dir, { recursive: true })
}

function loadCheckpoint(filePath) {
  if (!existsSync(filePath)) return null
  try {
    const raw = readFileSync(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function saveCheckpoint(filePath, data) {
  ensureParentDir(filePath)
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

const cities = splitCsv(process.env.TARGET_LOCATIONS)
if (cities.length === 0) {
  console.error('No TARGET_LOCATIONS found. Set TARGET_LOCATIONS in .env or env vars.')
  process.exit(1)
}

const keyword = (process.env.LOOP_KEYWORD || 'custom closet contractors').trim()
const startIndex = Math.max(0, toInt(process.env.LOOP_START_INDEX, 0))
const limit = Math.max(0, toInt(process.env.LOOP_LIMIT, 0))
const sleepMinSec = Math.max(0, toInt(process.env.LOOP_SLEEP_MIN, 8))
const sleepMaxSec = Math.max(sleepMinSec, toInt(process.env.LOOP_SLEEP_MAX, 20))
const checkpointFile =
  process.env.LOOP_CHECKPOINT_FILE ||
  path.join(process.cwd(), 'storage', 'loop-checkpoint.json')
const resumeEnabled = toBool(process.env.LOOP_RESUME, true)
const resetCheckpoint = toBool(process.env.LOOP_RESET_CHECKPOINT, false)

const selectedCities =
  limit > 0
    ? cities.slice(startIndex, startIndex + limit)
    : cities.slice(startIndex)

if (selectedCities.length === 0) {
  console.error('No cities selected after applying LOOP_START_INDEX / LOOP_LIMIT.')
  process.exit(1)
}

if (resetCheckpoint && existsSync(checkpointFile)) {
  rmSync(checkpointFile)
  console.log(`[loop] Removed checkpoint file: ${checkpointFile}`)
}

const runKey = `${keyword}::${startIndex}::${limit || 'all'}`
const checkpoint = resumeEnabled ? loadCheckpoint(checkpointFile) : null

let resumeCursor = startIndex
if (checkpoint && checkpoint.runKey === runKey) {
  resumeCursor = Math.max(startIndex, toInt(checkpoint.nextIndex, startIndex))
  console.log(
    `[loop] Resuming from checkpoint index ${resumeCursor} ` +
      `(last city: ${checkpoint.lastCity || 'n/a'})`
  )
}

if (resumeEnabled && !checkpoint) {
  saveCheckpoint(checkpointFile, {
    version: 1,
    runKey,
    keyword,
    startIndex,
    limit,
    totalCities: selectedCities.length,
    nextIndex: startIndex,
    lastCity: null,
    lastRunAt: null,
    completedCount: 0,
  })
}

const effectiveStart = Math.max(0, resumeCursor - startIndex)
const effectiveCities = selectedCities.slice(effectiveStart)

if (effectiveCities.length === 0) {
  console.log('[loop] All selected cities already processed for this run key.')
  process.exit(0)
}

console.log(
  `[loop] Starting ${effectiveCities.length}/${selectedCities.length} pending city runs from index ${startIndex}. ` +
    `keyword="${keyword}"`
)

for (let i = 0; i < effectiveCities.length; i += 1) {
  const city = effectiveCities[i]
  const absoluteIndex = startIndex + effectiveStart + i
  const query = `${keyword} ${city}`.trim()
  const startUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}/`

  console.log(`\n[loop] (${i + 1}/${effectiveCities.length}) idx=${absoluteIndex} ${city}`)
  console.log(`[loop] START_URLS=${startUrl}`)

  const env = {
    ...process.env,
    START_URLS: startUrl,
    HEADLESS: process.env.HEADLESS || 'true',
    DISABLE_WEBHOOKS: process.env.DISABLE_WEBHOOKS || 'true',
    MAX_CONCURRENCY: process.env.MAX_CONCURRENCY || '2',
    MAX_RESULTS_PER_QUERY: process.env.MAX_RESULTS_PER_QUERY || '40',
    MAX_REQUESTS_PER_CRAWL: process.env.MAX_REQUESTS_PER_CRAWL || '60',
  }

  const result = spawnSync('npm', ['run', 'start:dev'], {
    stdio: 'inherit',
    env,
  })

  if (result.status !== 0) {
    saveCheckpoint(checkpointFile, {
      version: 1,
      runKey,
      keyword,
      startIndex,
      limit,
      totalCities: selectedCities.length,
      nextIndex: absoluteIndex,
      lastCity: city,
      lastRunAt: new Date().toISOString(),
      completedCount: absoluteIndex - startIndex,
      status: 'failed',
    })
    console.error(`[loop] Run failed for city: ${city}. Exit code: ${result.status}`)
    process.exit(result.status || 1)
  }

  if (resumeEnabled) {
    saveCheckpoint(checkpointFile, {
      version: 1,
      runKey,
      keyword,
      startIndex,
      limit,
      totalCities: selectedCities.length,
      nextIndex: absoluteIndex + 1,
      lastCity: city,
      lastRunAt: new Date().toISOString(),
      completedCount: absoluteIndex + 1 - startIndex,
      status: 'running',
    })
  }

  if (i < effectiveCities.length - 1) {
    const range = sleepMaxSec - sleepMinSec + 1
    const jitterSec = sleepMinSec + Math.floor(Math.random() * range)
    console.log(`[loop] Sleeping ${jitterSec}s before next city...`)
    await sleep(jitterSec * 1000)
  }
}

if (resumeEnabled) {
  saveCheckpoint(checkpointFile, {
    version: 1,
    runKey,
    keyword,
    startIndex,
    limit,
    totalCities: selectedCities.length,
    nextIndex: startIndex + selectedCities.length,
    lastCity: effectiveCities[effectiveCities.length - 1] || null,
    lastRunAt: new Date().toISOString(),
    completedCount: selectedCities.length,
    status: 'completed',
  })
}

console.log('\n[loop] Completed all selected city runs successfully.')
