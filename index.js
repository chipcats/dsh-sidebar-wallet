/**
 * dsh-sidebar-wallet — Host half.
 *
 * Publishes one read-only JSON route the sidebar readout polls:
 *   - the official DeepSeek wallet balance
 *   - today's (Beijing day) spend
 *
 * Balance: the saved DEEPSEEK_API_KEY against `GET /user/balance`, then the
 * signed-in account wallet. The API key has no documented per-day spend
 * endpoint, so "today" prefers the Platform console's own usage export
 * (`/api/v0/usage/export`, a private web endpoint authenticated by the signed-in
 * account session) — the same numbers the console shows. When that session or
 * endpoint is unavailable, the Host falls back to a local estimate derived from
 * DSH's session logs: every `assistant/message` event lists its token usage,
 * priced with the official CNY table (off-peak prices; peak hours bill at 2x).
 * The payload's `today.source` says which one is in effect, and the readout
 * marks an estimate with "≈".
 *
 * Everything here is defensive on purpose: a cosmetic sidebar readout must never
 * be able to break the harness, so optional services are resolved with
 * `root.get(...)` and every failure degrades to a status string.
 */
import { inflateRawSync } from 'node:zlib'

export const name = 'dsh-sidebar-wallet'

// ---------------------------------------------------------------------------
// Beijing calendar helpers (peak/off-peak and the day boundary are Beijing ones)
// ---------------------------------------------------------------------------

const BEIJING_OFFSET_MS = 8 * 3600 * 1000
const DAY_MS = 24 * 3600 * 1000

/** Beijing-time peak windows: Monday-Friday 09:00-12:00 and 14:00-18:00. */
const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]

/**
 * Public holidays (Beijing calendar days) billed entirely at off-peak rates.
 * Only days actually OFF work are listed; every make-up workday falls on a
 * weekend, and weekends are off-peak anyway.
 *
 * ⚠️ Append the next year once the State Council publishes the arrangement
 * (usually each November). Until then an unlisted holiday reads as an ordinary
 * peak weekday here, a display-only inaccuracy.
 */
const HOLIDAY_VALLEY = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07',
])

/** Beijing calendar parts for one instant (read through UTC on a shifted clock). */
function beijingParts(ms) {
  const d = new Date(ms + BEIJING_OFFSET_MS)
  return {
    day: d.toISOString().slice(0, 10),
    hour: d.getUTCHours(),
    weekday: d.getUTCDay(), // 0 Sunday .. 6 Saturday
  }
}

/** Whether one instant falls inside a peak window. */
function isPeak(ms) {
  const { day, hour, weekday } = beijingParts(ms)
  if (weekday === 0 || weekday === 6) return false
  if (HOLIDAY_VALLEY.has(day)) return false
  return PEAK_HOURS.some(([start, end]) => hour >= start && hour < end)
}

/** Beijing calendar day key (`YYYY-MM-DD`) of one instant. */
function beijingDayKey(ms) {
  return beijingParts(ms).day
}

/** Epoch ms of Beijing midnight that starts the day containing `ms`. */
function beijingDayStart(ms) {
  return Math.floor((ms + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS - BEIJING_OFFSET_MS
}

/** The next instant at which peak/off-peak flips, as epoch ms (8-day horizon). */
function nextSwitchAt(ms) {
  const current = isPeak(ms)
  const start = Math.floor(ms / 60000) * 60000
  for (let t = start + 60000; t <= start + 8 * DAY_MS; t += 60000) {
    if (isPeak(t) !== current) return t
  }
  return null
}

// ---------------------------------------------------------------------------
// Pricing (official CNY table, per 1M tokens; peak = exactly 2x off-peak)
// ---------------------------------------------------------------------------

/** Off-peak CNY prices per 1M tokens: cache-hit input, cache-miss input, output. */
const PRICES_OFFPEAK = {
  'deepseek-flash': { hit: 0.02, miss: 1, out: 4 },
  'deepseek-v4-pro': { hit: 0.15, miss: 4.5, out: 13.5 },
}

/** Fold the aliases the official page documents onto the billed model ids. */
function billedModel(model) {
  const id = String(model || '').trim().toLowerCase()
  if (!id) return null
  if (id === 'deepseek-v4-pro' || id.startsWith('deepseek-v4-pro')) return 'deepseek-v4-pro'
  if (id === 'deepseek-flash' || id.startsWith('deepseek-v4-flash') || id.startsWith('deepseek-flash')) return 'deepseek-flash'
  return null
}

/**
 * One call's estimated CNY cost. Cache reads and cache writes bill at the
 * cache-hit price (the official rule), uncached input at the cache-miss price;
 * reasoning tokens are already reported separately and are not billed.
 */
function callCost(usage, model, atMs) {
  const key = billedModel(model)
  if (!key || !usage) return null
  const price = PRICES_OFFPEAK[key]
  const tier = isPeak(atMs) ? 2 : 1
  const miss = Number(usage.inputTokens) || 0
  const hit = (Number(usage.cacheReadTokens) || 0) + (Number(usage.cacheWriteTokens) || 0)
  const out = Number(usage.outputTokens) || 0
  return ((miss * price.miss + hit * price.hit + out * price.out) / 1e6) * tier
}

function emptyAggregate() {
  return {
    cost: 0,
    calls: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    models: {},
  }
}

/** Fold one usage block into a day aggregate; unpriced models are skipped. */
function addCall(agg, usage, model, atMs) {
  if (!usage) return
  const cost = callCost(usage, model, atMs)
  if (cost === null) return
  const key = billedModel(model)
  agg.calls += 1
  agg.cost += cost
  agg.inputTokens += Number(usage.inputTokens) || 0
  agg.cacheReadTokens += Number(usage.cacheReadTokens) || 0
  agg.cacheWriteTokens += Number(usage.cacheWriteTokens) || 0
  agg.outputTokens += Number(usage.outputTokens) || 0
  const perModel = agg.models[key] || (agg.models[key] = { model: key, cost: 0, calls: 0 })
  perModel.cost += cost
  perModel.calls += 1
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6
}

// ---------------------------------------------------------------------------
// Official today usage (Platform web API, authenticated by the signed-in account)
// ---------------------------------------------------------------------------
//
// The API key has no documented usage endpoint. The console's own "today" figure
// comes from a private Platform web endpoint that speaks the browser session:
//
//   GET {platform}/api/v0/usage/export?start=<unix>&end=<unix>&tz=0
//
// It answers with a ZIP of CSV rows (utc_date, type, amount, price, model,
// api_key_name) for that window; spend is sum(price * amount) over token rows.
// DSH already holds that Platform session for the signed-in account, so the Host
// reads it through `deepseekAccount.getPlatformSession()` instead of asking the
// user to paste a token. These endpoints are private and may change, so every
// failure falls back to the local estimate rather than surfacing an error.

const PLATFORM_USAGE_EXPORT = '/api/v0/usage/export'
const PLATFORM_USAGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
/** How long one official reading stays fresh. */
const OFFICIAL_TTL_MS = 60_000
const OFFICIAL_TIMEOUT_MS = 25_000
const MAX_EXPORT_BYTES = 64 * 1024 * 1024
const MAX_ZIP_OUTPUT_BYTES = 32 * 1024 * 1024
const MAX_ZIP_ENTRIES = 32

function usageError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** Beijing day window in epoch seconds; the export accepts whole-hour bounds. */
function beijingUsageWindow(now) {
  const start = Math.floor(beijingDayStart(now) / 1000)
  const end = Math.max(Math.ceil(now / 3600000) * 3600, start + 3600)
  return { start, end }
}

/** Split one CSV line, honouring the quoted fields the export emits. */
function parseCsvLine(line) {
  const fields = []
  let current = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"'
        i += 1
      } else if (ch === '"') {
        quoted = false
      } else {
        current += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      fields.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
}

function parseUsageCsv(text) {
  if (typeof text !== 'string' || text.trim() === '') return []
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return []
  const headers = parseCsvLine(lines[0].replace(/^\uFEFF/, '')).map((header) => header.trim())
  const rows = []
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue
    const values = parseCsvLine(lines[i].trim())
    const row = {}
    headers.forEach((header, index) => {
      row[header] = index < values.length ? values[index] : ''
    })
    rows.push(row)
  }
  return rows
}

/** Read the ZIP central directory and inflate its CSV entries. */
function extractZipCsv(buffer) {
  let end = -1
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer[i] === 0x50 && buffer[i + 1] === 0x4b && buffer[i + 2] === 0x05 && buffer[i + 3] === 0x06) {
      end = i
      break
    }
  }
  if (end < 0) return null
  const count = buffer.readUInt16LE(end + 10)
  if (count > MAX_ZIP_ENTRIES) return null
  let offset = buffer.readUInt32LE(end + 16)
  const files = {}
  let total = 0
  for (let n = 0; n < count; n += 1) {
    if (offset < 0 || offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) return null
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    if (offset + 46 + nameLength + extraLength > buffer.length) return null
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    if (localOffset + 30 > buffer.length) return null
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart > buffer.length || compressedSize > buffer.length - dataStart) return null
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize)
    let data = null
    try {
      data =
        method === 0
          ? compressed
          : method === 8
            ? inflateRawSync(compressed, { maxOutputLength: MAX_ZIP_OUTPUT_BYTES })
            : null
    } catch {
      return null
    }
    if (data === null) return null
    total += data.length
    if (total > MAX_ZIP_OUTPUT_BYTES) return null
    if (name.toLowerCase().endsWith('.csv')) files[name] = data.toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength
  }
  return files
}

/** The export is a ZIP holding CSVs; a plain CSV body is accepted too. */
function csvTextOfExport(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const files = extractZipCsv(buffer)
    if (files === null) return null
    const names = Object.keys(files)
    const preferred = names.find((name) => name.toLowerCase().includes('amount')) || names[0]
    return preferred === undefined ? null : files[preferred]
  }
  return buffer.toString('utf8')
}

/** Today's spend from the Platform export, in CNY. Throws on any unusable answer. */
async function fetchOfficialTodayUsage(root) {
  const account = root.get('deepseekAccount')
  const session = account && typeof account.getPlatformSession === 'function' ? await account.getPlatformSession() : null
  if (!session || typeof session.token !== 'string' || session.token === '') {
    throw usageError('NO_ACCOUNT', '未登录 DeepSeek 账号')
  }
  const origin = String(session.origin || 'https://platform.deepseek.com').replace(/\/+$/, '')
  const { start, end } = beijingUsageWindow(Date.now())
  const url = `${origin}${PLATFORM_USAGE_EXPORT}?start=${start}&end=${end}&tz=0`
  const headers = {
    accept: 'application/octet-stream',
    authorization: `Bearer ${session.token}`,
    'x-dsh-auth-token': session.token,
    referer: `${origin}/usage`,
    'user-agent': PLATFORM_USAGE_UA,
    ...(session.requestHeaders && typeof session.requestHeaders === 'object' ? session.requestHeaders : {}),
  }

  let response
  try {
    response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(OFFICIAL_TIMEOUT_MS) })
  } catch (err) {
    throw usageError('NETWORK', `官方用量接口请求失败：${String(err?.message || err).slice(0, 120)}`)
  }
  if (response.status === 401 || response.status === 403) {
    throw usageError('AUTH', `官方用量接口拒绝访问（HTTP ${response.status}）`)
  }
  if (response.status !== 200) throw usageError('HTTP', `官方用量接口返回 HTTP ${response.status}`)

  let buffer
  try {
    buffer = Buffer.from(await response.arrayBuffer())
  } catch {
    throw usageError('BODY', '官方用量导出读取失败')
  }
  if (buffer.length > MAX_EXPORT_BYTES) throw usageError('SIZE', '官方用量导出过大')
  const csv = csvTextOfExport(buffer)
  if (csv === null) throw usageError('SHAPE', '官方用量导出格式异常')

  const rows = parseUsageCsv(csv)
  const aggregate = { cost: 0, tokens: 0, requests: 0, cacheHit: 0, cacheMiss: 0, output: 0 }
  for (const row of rows) {
    const type = String(row.type || '')
    const amount = Number(row.amount)
    if (!Number.isFinite(amount)) continue
    if (type === 'request_count') {
      aggregate.requests += amount
      continue
    }
    if (type !== 'output_tokens' && type !== 'input_cache_hit_tokens' && type !== 'input_cache_miss_tokens') continue
    aggregate.tokens += amount
    if (type === 'output_tokens') aggregate.output += amount
    else if (type === 'input_cache_hit_tokens') aggregate.cacheHit += amount
    else aggregate.cacheMiss += amount
    const price = Number(row.price)
    if (Number.isFinite(price)) aggregate.cost += price * amount
  }
  if (rows.length > 0 && aggregate.tokens === 0 && aggregate.requests === 0) {
    throw usageError('SHAPE', '官方用量 CSV 字段无法识别')
  }
  return {
    ...aggregate,
    cost: round6(aggregate.cost),
    currency: 'CNY',
    at: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

function isLoopbackHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  if (Number(m[1]) !== 127) return false
  return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}

function sendJson(res, body, status = 200) {
  const text = JSON.stringify(body)
  if (res.headersSent) return
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(text)),
  })
  res.end(text)
}

// ---------------------------------------------------------------------------
// Host plugin
// ---------------------------------------------------------------------------

/** How long a fetched balance stays fresh. */
const BALANCE_TTL_MS = 25_000
/** Balance refresh cadence while a browser is watching. */
const SAMPLE_INTERVAL_MS = 60_000
/** Stop background refreshes this long after the last browser poll. */
const SAMPLE_IDLE_MS = 10 * 60_000

export default {
  name,

  /**
   * No object-level `inject`: the Web carrier is awaited in its own child scope,
   * so a host without a Web server simply mounts nothing. Single parameter is
   * intentional — Cordis calls `apply(ctx)` unless a Config schema is declared.
   */
  apply(root) {
    const state = {
      balance: null, // { amount, currency, source, at }
      balanceError: null,
      lastPoll: 0,
      refreshing: false,
      todayDay: beijingDayKey(Date.now()),
      today: emptyAggregate(),
      todayScanned: false,
      todayScannedAt: 0,
      scanning: false,
      /** Official Platform reading: { value, error, at, lastTry, inflight }. */
      official: { value: null, error: null, at: 0, lastTry: 0, inflight: null },
      /** Starts the effect-owned background refresh chain; set while mounted. */
      startRefresh: null,
    }

    // -- balance ------------------------------------------------------------
    const accountClient = () => ({
      version: process.env.DSH_CLIENT_VERSION || '0.2.0',
      locale: 'zh-CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    })

    /** The signed-in DeepSeek account's wallet, when there is one. */
    const accountBalance = async () => {
      try {
        const account = root.get('deepseekAccount')
        if (!account || typeof account.getBalance !== 'function') return null
        const result = await account.getBalance(accountClient())
        const wallets = result?.status === 'ready' ? result.value : null
        if (!Array.isArray(wallets) || wallets.length === 0) return null
        const pick = wallets.find((w) => w?.currency === 'CNY') ?? wallets[0]
        const amount = Number(pick?.balance)
        if (!Number.isFinite(amount)) return null
        return { amount, currency: String(pick?.currency || 'CNY'), source: 'account', at: Date.now() }
      } catch {
        return null
      }
    }

    const fetchBalance = async () => {
      let key
      try {
        key = await root.get('credentials')?.resolve('DEEPSEEK_API_KEY')
      } catch {
        key = undefined
      }

      if (key?.value !== undefined) {
        try {
          const res = await fetch('https://api.deepseek.com/user/balance', {
            headers: { Authorization: `Bearer ${key.value}` },
            signal: AbortSignal.timeout(10_000),
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = await res.json()
          const info = Array.isArray(data?.balance_infos) ? data.balance_infos[0] : null
          const amount = Number(info?.total_balance ?? data?.total_balance)
          if (!Number.isFinite(amount)) throw new Error('余额接口返回结构异常')
          state.balanceError = null
          return { amount, currency: String(info?.currency || 'CNY'), source: 'apikey', at: Date.now() }
        } catch (err) {
          state.balanceError = `余额接口请求失败：${String(err?.message || err).slice(0, 160)}`
        }
      }

      const account = await accountBalance()
      if (account) {
        state.balanceError = null
        return account
      }
      if (key?.value === undefined && state.balanceError === null) {
        state.balanceError = '未配置 DEEPSEEK_API_KEY，且未登录 DeepSeek 账号'
      }
      return null
    }

    const ensureBalance = async (force = false) => {
      if (!force && state.balance && Date.now() - state.balance.at < BALANCE_TTL_MS) return state.balance
      const next = await fetchBalance()
      if (next) state.balance = next
      return state.balance
    }

    // -- today's spend: official Platform usage, local estimate fallback -----
    /** Refresh the official reading (TTL + in-flight dedup + 10s retry backoff). */
    const ensureOfficial = async (force = false) => {
      const now = Date.now()
      if (!force && state.official.inflight === null) {
        if (state.official.value !== null && now - state.official.at < OFFICIAL_TTL_MS) return state.official
        if (now - state.official.lastTry < 10_000) return state.official
      }
      if (state.official.inflight !== null) return state.official.inflight
      state.official.inflight = (async () => {
        try {
          const value = await fetchOfficialTodayUsage(root)
          state.official.value = value
          state.official.error = null
          state.official.at = Date.now()
        } catch (err) {
          state.official.error = String(err?.message || err).slice(0, 160)
        } finally {
          state.official.inflight = null
          state.official.lastTry = Date.now()
        }
        return state.official
      })()
      return state.official.inflight
    }

    // -- today's spend (session-log replay) ---------------------------------
    /**
     * Replay every session that has events in the current Beijing day and price
     * its assistant-message usage blocks. Replayed on demand — only when the
     * official Platform figure is unavailable and the payload needs a fallback —
     * never at boot and never on a manual refresh; the official number covers
     * the normal path and the live `session/event` feed keeps this current.
     */
    const scanToday = async () => {
      if (state.scanning) return
      state.scanning = true
      const dayKey = beijingDayKey(Date.now())
      const dayStart = beijingDayStart(Date.now())
      const agg = emptyAggregate()
      let scanned = false
      try {
        const q = root.get('sessionQuery')
        if (q && typeof q.listSessions === 'function' && typeof q.readSession === 'function') {
          const records = await q.listSessions()
          for (const record of Array.isArray(records) ? records : []) {
            const id = record?.header?.id
            if (!id) continue
            try {
              let active = true
              if (typeof q.listEvents === 'function') {
                const events = await q.listEvents(id)
                active = Array.isArray(events) && events.some((e) => typeof e?.time === 'number' && e.time >= dayStart)
              }
              if (!active) continue
              const snapshot = await q.readSession(id)
              for (const event of snapshot?.events || []) {
                if (event?.type !== 'assistant/message') continue
                if (typeof event.time !== 'number' || event.time < dayStart) continue
                addCall(agg, event.data?.usage, event.data?.message?.source?.model, event.time)
              }
            } catch {
              // One unreadable session must not stop the scan.
            }
          }
          scanned = true
        }
      } catch {
        scanned = false
      } finally {
        if (beijingDayKey(Date.now()) === dayKey) {
          state.today = agg
          state.todayScanned = scanned
          state.todayScannedAt = Date.now()
          state.todayDay = dayKey
        }
        state.scanning = false
      }
    }

    /** Reset the aggregate when the Beijing day flips; the replay stays lazy. */
    const ensureToday = (now = Date.now()) => {
      const key = beijingDayKey(now)
      if (key !== state.todayDay) {
        state.todayDay = key
        state.today = emptyAggregate()
        state.todayScanned = false
        state.official = { value: null, error: null, at: 0, lastTry: 0, inflight: null }
        void ensureOfficial()
      }
    }

    // Live append feed: one call per assistant message, priced at commit time.
    root.on('session/event', (session, event) => {
      try {
        if (event?.type !== 'assistant/message') return
        const usage = event.data?.usage
        if (!usage) return
        const at = typeof event.time === 'number' ? event.time : Date.now()
        if (beijingDayKey(at) !== state.todayDay) ensureToday(at)
        // The event that caused a rollover belongs to the new day.
        if (beijingDayKey(at) === state.todayDay) {
          addCall(state.today, usage, event.data?.message?.source?.model, at)
        }
      } catch {
        /* the readout must not be able to break the event feed */
      }
    })

    // A timer that only shuffles the aggregate across midnight; the replay is
    // requested lazily from `snapshot` when the fallback is actually needed.
    root.effect(() => {
      const timer = setInterval(() => ensureToday(), 60_000)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    }, 'dsh-sidebar-wallet: day rollover')

    // -- background refresh while a browser watches -------------------------
    // The chain is owned by this plugin's effect: unloading or reloading the
    // plugin clears the pending timer, so no orphan loop keeps fetching.
    root.effect(() => {
      let timer = null
      let disposed = false
      let running = false
      const schedule = (delay) => {
        if (disposed) return
        timer = setTimeout(() => void run(), delay)
        if (typeof timer.unref === 'function') timer.unref()
      }
      const run = async () => {
        timer = null
        if (disposed || running) return
        running = true
        let again = true
        try {
          if (Date.now() - state.lastPoll > SAMPLE_IDLE_MS) {
            state.refreshing = false
            again = false
            return
          }
          try {
            await ensureBalance()
          } catch {
            /* keep refreshing */
          }
          if (disposed) return
          try {
            await ensureOfficial()
          } catch {
            /* keep refreshing */
          }
        } finally {
          running = false
          if (!disposed && again && timer === null) schedule(SAMPLE_INTERVAL_MS)
        }
      }
      state.startRefresh = () => {
        if (disposed || timer !== null || running) return
        schedule(0)
      }
      return () => {
        disposed = true
        state.startRefresh = null
        if (timer !== null) clearTimeout(timer)
        timer = null
      }
    }, 'dsh-sidebar-wallet: background refresh')

    const snapshot = async (force) => {
      state.lastPoll = Date.now()
      if (!state.refreshing) {
        state.refreshing = true
        if (state.startRefresh) state.startRefresh()
      }
      ensureToday()
      // Official usage and the API balance are independent; fetch them together.
      const [official] = await Promise.all([
        ensureOfficial(force).catch(() => state.official),
        ensureBalance(force).catch((err) => {
          state.balanceError = String(err?.message || err).slice(0, 160)
          return state.balance
        }),
      ])
      const now = Date.now()
      ensureToday(now)
      // Official figure unavailable: replay today's logs once so the fallback
      // has data on the very request that needs it (instead of a blank readout).
      if (official.value === null && !state.todayScanned && !state.scanning) {
        try {
          await scanToday()
        } catch {
          /* the fallback degrades to the live accumulator */
        }
      }
      const local = state.today
      const localCost = round6(local.cost)
      const officialValue = official.value
      const byModel = Object.values(local.models)
        .map((m) => ({ model: m.model, cost: round6(m.cost), calls: m.calls }))
        .sort((a, b) => b.cost - a.cost)
      const todayPayload =
        officialValue === null
          ? {
              day: state.todayDay,
              source: 'estimate',
              cost: localCost,
              requests: local.calls,
              tokens: local.inputTokens + local.cacheReadTokens + local.cacheWriteTokens + local.outputTokens,
              cacheHitTokens: local.cacheReadTokens + local.cacheWriteTokens,
              cacheMissTokens: local.inputTokens,
              outputTokens: local.outputTokens,
              officialAt: null,
              officialError: official.error,
              scanned: state.todayScanned,
              scannedAt: state.todayScannedAt,
              byModel,
            }
          : {
              day: state.todayDay,
              source: 'official',
              cost: round6(officialValue.cost),
              requests: officialValue.requests,
              tokens: officialValue.tokens,
              cacheHitTokens: officialValue.cacheHit,
              cacheMissTokens: officialValue.cacheMiss,
              outputTokens: officialValue.output,
              officialAt: officialValue.at,
              officialError: official.error,
              scanned: state.todayScanned,
              scannedAt: state.todayScannedAt,
              byModel,
            }
      return {
        ok: true,
        balance: state.balance ? state.balance.amount : null,
        currency: state.balance?.currency ?? 'CNY',
        balanceSource: state.balance?.source ?? null,
        balanceAt: state.balance?.at ?? null,
        balanceError: state.balanceError,
        today: todayPayload,
        period: {
          peak: isPeak(now),
          nextSwitchAt: nextSwitchAt(now),
          peakHours: PEAK_HOURS,
        },
        serverTime: now,
      }
    }

    // -- read-only route ----------------------------------------------------
    root.inject(['webServer'], (ctx) => {
      /** Same-origin + loopback fence: the wallet is the operator's, not the LAN's. */
      const rejected = (req, res) => {
        try {
          const headers = req?.headers ?? {}
          const hostUrl = new URL(`http://${String(headers.host || '')}`)
          const trusted = String(process.env.DSH_BALANCE_TRUSTED_HOSTS || '')
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
          if (!isLoopbackHostname(hostUrl.hostname) && !trusted.includes(hostUrl.host.toLowerCase())) {
            sendJson(res, { ok: false, error: 'forbidden host' }, 403)
            return true
          }
          if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
            sendJson(res, { ok: false, error: 'cross-site request' }, 403)
            return true
          }
          const origin = headers.origin
          if (typeof origin === 'string' && origin && origin !== 'null') {
            if (new URL(origin).host.toLowerCase() !== hostUrl.host.toLowerCase()) {
              sendJson(res, { ok: false, error: 'origin mismatch' }, 403)
              return true
            }
          }
          const fence = ctx.get('connection')
          if (fence && typeof fence.requestRejection === 'function') {
            const code = fence.requestRejection(req)
            if (code) {
              sendJson(res, { ok: false, error: 'untrusted request' }, code)
              return true
            }
          }
          return false
        } catch {
          sendJson(res, { ok: false, error: 'bad request' }, 403)
          return true
        }
      }

      ctx.effect(
        () =>
          ctx.webServer.register({
            kind: 'exact',
            path: '/dsh-sidebar-wallet/state.json',
            handler: async (req, res) => {
              if (rejected(req, res)) return
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                sendJson(res, { ok: false, error: 'method not allowed' }, 405)
                return
              }
              let force = false
              try {
                force = new URL(req.url || '/', 'http://localhost').searchParams.get('refresh') === '1'
              } catch {
                force = false
              }
              try {
                sendJson(res, await snapshot(force))
              } catch (err) {
                sendJson(res, { ok: false, error: String(err?.message || err).slice(0, 200) })
              }
            },
          }),
        'dsh-sidebar-wallet: state route',
      )
    })
  },
}
