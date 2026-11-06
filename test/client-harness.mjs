// Test harness for the browser half.
//
// `client.js` is a plain script that registers through `window.__ModuleLoader__`
// and pulls React out of the shell's module table. This harness provides those
// two globals, renders the component with stubbed hooks, and returns the text
// and element tree so tests can assert on the localized output.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(HERE, '..')

export const CLIENT_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'client.js'), 'utf8')

const NOOP = () => {}

function makeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useEffect: NOOP,
    useLayoutEffect: NOOP,
    useRef: () => ({ current: null }),
    useState: (init) => [typeof init === 'function' ? init() : init, NOOP],
  }
}

/**
 * Load `client.js` in the given language and return:
 * - `exports` / `registered`: what the plugin registered into the slot;
 * - `render(presets)`: render one Readout with the given hook-state presets.
 *
 * `presets` is indexed by `useState` call order: 0 snapshot, 1 error,
 * 2 placement, 3 hovered, 4 open, 5 now, 6 refreshing, 7 compact.
 */
export function mountClient(language) {
  let factory = null
  const pageWindow = { __ModuleLoader__: { load: (options) => { factory = options.factory } } }
  const navigator = { language }
  const React = makeReact()
  let hookIndex = 0
  let presets = []

  React.useState = (init) => {
    const index = hookIndex++
    if (index < presets.length) return [presets[index], NOOP]
    return [typeof init === 'function' ? init() : init, NOOP]
  }

  const requireFn = (name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  }
  const noDocument = {
    addEventListener: NOOP,
    removeEventListener: NOOP,
    hidden: false,
    querySelector: () => null,
  }
  const run = new Function(
    'window',
    'navigator',
    'document',
    'ResizeObserver',
    'requestAnimationFrame',
    'setInterval',
    'clearInterval',
    CLIENT_SOURCE,
  )
  run(pageWindow, navigator, noDocument, undefined, NOOP, () => 0, NOOP)

  if (!factory) throw new Error('client.js did not register a module factory')
  const exports = factory(requireFn)

  let registered = null
  exports.apply({
    slots: {
      inject: (_name, fn) => fn(),
      register: (config, component) => {
        registered = { config, component }
        return config
      },
    },
  })

  function render(renderPresets = []) {
    hookIndex = 0
    presets = renderPresets
    const tree = registered.component({ wide: true })
    const texts = []
    const buttons = []
    const walk = (node) => {
      if (node === null || node === undefined || node === false) return
      if (Array.isArray(node)) {
        for (const child of node) walk(child)
        return
      }
      if (typeof node === 'string' || typeof node === 'number') {
        const text = String(node)
        if (text.trim() !== '') texts.push(text)
        return
      }
      if (typeof node === 'object') {
        if (node.type === 'button') buttons.push(node.props)
        for (const child of node.children || []) walk(child)
      }
    }
    walk(tree)
    return { texts, buttons }
  }

  return { exports, registered, render }
}

/** A complete official-coverage snapshot the cards can render from. */
export function snapshotFixture(overrides = {}) {
  const now = Date.now()
  const today = {
    source: 'official',
    cost: 12.34,
    requests: 56,
    cacheHitTokens: 8_600_000,
    cacheMissTokens: 128_000,
    cacheHitRate: 0.985,
    outputTokens: 92_400,
    officialError: null,
    officialErrorCode: null,
    officialErrorStatus: null,
    scanned: true,
    ...overrides.today,
  }
  return {
    ok: true,
    balance: 128,
    currency: 'CNY',
    balanceSource: 'apikey',
    balanceAt: now,
    balanceError: null,
    balanceErrorCode: null,
    balanceErrorStatus: null,
    ...overrides,
    today,
  }
}

/** Hook-state presets for a rendered readout. */
export function readoutPresets({ snapshot = null, error = null, open = false, compact = false } = {}) {
  const placement = { left: 100, top: 720, width: 150, height: 20, available: 300, cardRight: 268, cardMaxWidth: 260 }
  return [snapshot, error, placement, false, open, Date.now(), false, compact]
}

/** Extract the TEXT dictionary of one language straight from the source. */
export function textKeys(language) {
  const marker = language === 'zh' ? '\n\t\t\tzh: {' : '\n\t\t\ten: {'
  const markerIndex = CLIENT_SOURCE.indexOf(marker)
  if (markerIndex < 0) throw new Error('TEXT.' + language + ' not found')
  const blockStart = markerIndex + marker.length
  let depth = 1
  let blockEnd = -1
  for (let i = blockStart; i < CLIENT_SOURCE.length; i++) {
    const ch = CLIENT_SOURCE[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        blockEnd = i
        break
      }
    }
  }
  if (blockEnd < 0) throw new Error('TEXT.' + language + ' is not balanced')
  const block = CLIENT_SOURCE.slice(blockStart, blockEnd)
  const topKeys = []
  const errorKeys = []
  let inErrors = false
  let errorsDepth = 0
  for (const line of block.split('\n')) {
    const trimmed = line.trim()
    const topMatch = /^([A-Za-z][A-Za-z0-9]*):/.exec(trimmed)
    if (!inErrors && topMatch && !trimmed.startsWith('errors:')) topKeys.push(topMatch[1])
    if (trimmed.startsWith('errors: {')) {
      inErrors = true
      errorsDepth = 1
      continue
    }
    if (inErrors) {
      if (trimmed.startsWith('}')) {
        errorsDepth -= 1
        if (errorsDepth === 0) inErrors = false
        continue
      }
      const keyMatch = /^([A-Z_]+):/.exec(trimmed)
      if (keyMatch) errorKeys.push(keyMatch[1])
    }
  }
  return { topKeys, errorKeys }
}
