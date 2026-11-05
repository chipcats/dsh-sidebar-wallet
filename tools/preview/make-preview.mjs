// Regenerate assets/preview.png from tools/preview/preview.html.
//
// The image is a sample-data mock, not a screenshot: a headless Edge/Chrome
// renders the HTML at 2x, this script trims the uniform background (PNG
// decode/crop/encode in plain Node, no dependencies) and writes the PNG.
//
// Usage: node tools/preview/make-preview.mjs [--out <file>] [--scale <n>]
//        [--html <file>] [--edge <exe>]
// Requires Node >= 20 and Microsoft Edge (or Chrome/Chromium) installed.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')

/** CSS viewport used for the render; extra space is trimmed afterwards. */
const VIEWPORT = { width: 368, height: 420 }
/** Transparent-to-content margin kept around the trimmed image (CSS px, scaled with --scale). */
const MARGIN_CSS = 8

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === '--out') args.out = argv[++i]
    else if (key === '--scale') args.scale = Number(argv[++i])
    else if (key === '--html') args.html = argv[++i]
    else if (key === '--edge') args.edge = argv[++i]
    else if (key === '--help' || key === '-h') args.help = true
    else throw new Error(`unknown argument: ${key}`)
  }
  return args
}

function which(name) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' })
  if (probe.status !== 0 || !probe.stdout) return null
  const first = probe.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
  return first || null
}

function findBrowser(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`browser not found: ${explicit}`)
    return explicit
  }
  const fromEnv = process.env.EDGE_PATH || process.env.CHROME_PATH
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  const byPlatform = {
    win32: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
    darwin: [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ],
    linux: ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  }
  for (const candidate of byPlatform[process.platform] || []) {
    if (fs.existsSync(candidate)) return candidate
  }
  const names = process.platform === 'win32' ? ['msedge', 'chrome'] : ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser']
  for (const name of names) {
    const found = which(name)
    if (found) return found
  }
  throw new Error('no Edge/Chrome found; pass --edge <path> or set EDGE_PATH')
}

function render(browser, htmlPath, pngPath, scale) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-preview-profile-'))
  const result = spawnSync(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      `--force-device-scale-factor=${scale}`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      `--screenshot=${pngPath}`,
      pathToFileURL(htmlPath).href,
    ],
    { timeout: 120_000, encoding: 'utf8' },
  )
  try {
    fs.rmSync(profile, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
  if (result.status !== 0 || !fs.existsSync(pngPath)) {
    const detail = `${result.error ? result.error.message : ''}\n${result.stderr || ''}`.trim().slice(0, 600)
    throw new Error(`headless render failed (exit ${result.status}): ${detail}`)
  }
}

// --- minimal 8-bit PNG decode / crop / encode (no dependencies) ------------

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')

function readPng(file) {
  const buf = fs.readFileSync(file)
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG file')
  let offset = 8
  let ihdr = null
  const idat = []
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      }
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
  }
  if (!ihdr) throw new Error('PNG has no IHDR')
  const channels = { 2: 3, 6: 4 }[ihdr.colorType]
  if (ihdr.depth !== 8 || ihdr.interlace !== 0 || !channels) {
    throw new Error(`unsupported PNG (depth ${ihdr.depth}, color ${ihdr.colorType}, interlace ${ihdr.interlace})`)
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = ihdr.width * channels
  const pixels = Buffer.alloc(stride * ihdr.height)
  let pos = 0
  for (let y = 0; y < ihdr.height; y++) {
    const filter = raw[pos++]
    const row = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = pixels.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? cur[x - channels] : 0
      const up = prev ? prev[x] : 0
      const upLeft = prev && x >= channels ? prev[x - channels] : 0
      let value = row[x]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      } else if (filter !== 0) {
        throw new Error(`unsupported PNG filter ${filter}`)
      }
      cur[x] = value & 0xff
    }
  }
  return { width: ihdr.width, height: ihdr.height, channels, pixels }
}

function contentBox(img, tolerance = 1) {
  const { width, height, channels, pixels } = img
  const bg = [pixels[0], pixels[1], pixels[2]]
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels
      const diff = Math.max(
        Math.abs(pixels[i] - bg[0]),
        Math.abs(pixels[i + 1] - bg[1]),
        Math.abs(pixels[i + 2] - bg[2]),
      )
      if (diff > tolerance) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) throw new Error('rendered image is empty')
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 }
}

function crop(img, box, margin) {
  const x0 = Math.max(0, box.x0 - margin)
  const y0 = Math.max(0, box.y0 - margin)
  const x1 = Math.min(img.width, box.x1 + margin)
  const y1 = Math.min(img.height, box.y1 + margin)
  const width = x1 - x0
  const height = y1 - y0
  const { channels } = img
  const pixels = Buffer.alloc(width * height * channels)
  const stride = img.width * channels
  for (let y = 0; y < height; y++) {
    img.pixels.copy(pixels, y * width * channels, (y0 + y) * stride + x0 * channels, (y0 + y) * stride + x1 * channels)
  }
  return { width, height, channels, pixels }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const name = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, crc])
}

function encodePng(img) {
  const { width, height, channels, pixels } = img
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// --- main ------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('usage: node tools/preview/make-preview.mjs [--out <file>] [--scale <n>] [--html <file>] [--edge <exe>]')
    return
  }
  const htmlPath = path.resolve(args.html || path.join(HERE, 'preview.html'))
  const outPath = path.resolve(args.out || path.join(REPO_ROOT, 'assets', 'preview.png'))
  const scale = Number.isFinite(args.scale) && args.scale > 0 ? Math.min(4, args.scale) : 2
  if (!fs.existsSync(htmlPath)) throw new Error(`html not found: ${htmlPath}`)

  const browser = findBrowser(args.edge)
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-preview-render-'))
  const rawPath = path.join(scratch, 'raw.png')
  try {
    console.log(`render  ${path.relative(REPO_ROOT, htmlPath)} -> ${path.basename(rawPath)} @${scale}x`)
    render(browser, htmlPath, rawPath, scale)
    const rendered = readPng(rawPath)
    const box = contentBox(rendered)
    const cropped = crop(rendered, box, Math.round(MARGIN_CSS * scale))
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, encodePng(cropped))
    console.log(`wrote   ${path.relative(REPO_ROOT, outPath)} (${cropped.width}x${cropped.height}, ${fs.statSync(outPath).size} bytes)`)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

try {
  main()
} catch (error) {
  console.error(`make-preview: ${error.message}`)
  process.exit(1)
}
