#!/usr/bin/env node
// Refresh holidays.json from NateScarlet/holiday-cn (MIT), which mirrors the
// State Council holiday announcements (gov.cn).
//
// Build-time only: the plugin ships the generated file, so the Host never
// fetches holiday data at runtime. Run this after the State Council publishes
// the next year's arrangement (usually each November), then release.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(HERE, '..', 'holidays.json')
const SOURCE = 'https://github.com/NateScarlet/holiday-cn'
const MIRRORS = [
  'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master',
  'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master',
]

const year = new Date().getUTCFullYear()
const years = [year, year + 1]

async function fetchYear(mirror, y) {
  const res = await fetch(`${mirror}/${y}.json`, { signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`${mirror}/${y}.json -> HTTP ${res.status}`)
  return res.json()
}

const days = new Set()
const papers = new Set()
for (const y of years) {
  let data = null
  for (const mirror of MIRRORS) {
    try {
      data = await fetchYear(mirror, y)
      break
    } catch (err) {
      console.warn(`mirror failed for ${y}: ${err.message}`)
    }
  }
  if (!data) continue
  for (const paper of data.papers || []) papers.add(paper)
  // Only statutory days off: make-up workdays are weekends, which bill off-peak.
  for (const day of data.days || []) if (day.isOffDay) days.add(day.date)
}

if (days.size === 0) {
  console.error('no holidays fetched; holidays.json left untouched')
  process.exit(1)
}

const payload = {
  source: SOURCE,
  note: 'Statutory holidays only (isOffDay=true). Make-up workdays are ignored: weekends are off-peak anyway.',
  papers: [...papers].sort(),
  days: [...days].sort(),
}
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n')
console.log(`wrote ${OUT} (${payload.days.length} days from ${papers.size} announcements)`)
