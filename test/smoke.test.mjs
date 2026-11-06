// Zero-dependency smoke tests: the plugin must stay installable and the
// browser half must keep rendering the expected localized output.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  CLIENT_SOURCE,
  REPO_ROOT,
  mountClient,
  snapshotFixture,
  readoutPresets,
  textKeys,
} from './client-harness.mjs'

const read = (relative) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8')
const HOST_SOURCE = read('index.js')

test('client registers the sidebar.footer.action slot', () => {
  const zh = mountClient('zh-CN')
  assert.deepEqual(zh.exports.inject, ['slots'])
  assert.equal(zh.registered.config.name, 'sidebar.footer.action')
  assert.equal(zh.registered.config.id, 'dsh-sidebar-wallet')
  assert.equal(zh.registered.config.order, 40)
  assert.equal(zh.registered.config.label(), '侧边栏钱包')
  assert.equal(mountClient('en-US').registered.config.label(), 'Sidebar Wallet')
})

test('pill shows the localized labels in full mode', () => {
  const snapshot = snapshotFixture()
  const zh = mountClient('zh-CN').render(readoutPresets({ snapshot }))
  assert.ok(zh.texts.includes('余额'), 'zh pill keeps the balance label')
  assert.ok(zh.texts.includes('今日'), 'zh pill keeps the today label')
  assert.ok(zh.texts.includes('¥128.00'))
  assert.ok(zh.texts.includes('¥12.34'))

  const en = mountClient('en-US').render(readoutPresets({ snapshot }))
  assert.ok(en.texts.includes('Balance'))
  assert.ok(en.texts.includes('Today'))
})

test('compact mode drops the pill labels but keeps the amounts', () => {
  const snapshot = snapshotFixture()
  const zh = mountClient('zh-CN').render(readoutPresets({ snapshot, compact: true }))
  assert.ok(!zh.texts.includes('余额'), 'compact pill has no balance label')
  assert.ok(!zh.texts.includes('今日'), 'compact pill has no today label')
  assert.ok(zh.texts.includes('¥128.00'))
  assert.ok(zh.texts.includes('¥12.34'))
})

test('hover card lists every row in both languages', () => {
  const snapshot = snapshotFixture()
  const zh = mountClient('zh-CN').render(readoutPresets({ snapshot, open: true }))
  for (const label of ['余额', '今日', '输入', '输出', '峰谷', '更新']) {
    assert.ok(zh.texts.includes(label), 'zh card row: ' + label)
  }
  assert.ok(zh.texts.includes('命中 8.6M · 未命中 128K'))
  assert.ok(zh.texts.includes('92.4K'))
  assert.ok(
    zh.texts.some((text) => text.includes('后转峰') || text.includes('后转谷')),
    'zh card shows the peak countdown',
  )

  const en = mountClient('en-US').render(readoutPresets({ snapshot, open: true }))
  for (const label of ['Balance', 'Today', 'Input', 'Output', 'Rate', 'Updated']) {
    assert.ok(en.texts.includes(label), 'en card row: ' + label)
  }
  assert.ok(en.texts.includes('Hit 8.6M · Miss 128K'))
  assert.ok(en.texts.some((text) => text.includes('peak in ') || text.includes('off-peak in ')))
})

test('card is closed when the readout is not hovered', () => {
  const zh = mountClient('zh-CN').render(readoutPresets({ snapshot: snapshotFixture() }))
  assert.ok(!zh.texts.includes('输入'), 'closed card must not render rows')
})

test('official usage errors are localized by code', () => {
  const snapshot = snapshotFixture({
    today: { officialError: 'raw host error', officialErrorCode: 'AUTH', officialErrorStatus: 403 },
  })
  const zh = mountClient('zh-CN').render(readoutPresets({ snapshot, open: true }))
  assert.ok(
    zh.texts.includes('官方用量刷新失败：接口拒绝了请求 (HTTP 403)'),
    'zh error note: ' + JSON.stringify(zh.texts),
  )
  const en = mountClient('en-US').render(readoutPresets({ snapshot, open: true }))
  assert.ok(
    en.texts.includes('Official usage refresh failed: The API rejected the request (HTTP 403)'),
    'en error note: ' + JSON.stringify(en.texts),
  )
})

test('local estimate is marked with ≈ and used when official fails', () => {
  const snapshot = snapshotFixture({
    today: {
      source: 'estimate',
      cost: 0.005,
      requests: 3,
      scanned: true,
      officialError: 'raw host error',
      officialErrorCode: 'NETWORK',
    },
  })
  for (const language of ['zh-CN', 'en-US']) {
    const view = mountClient(language).render(readoutPresets({ snapshot, open: true }))
    assert.ok(
      view.texts.includes('≈<¥0.01'),
      language + ' estimate marker: ' + JSON.stringify(view.texts),
    )
    assert.ok(view.texts.some((text) => text.startsWith('官方用量不可用：') || text.startsWith('Official usage unavailable: ')))
  }
})

test('cache hit rate row shows the host-computed ratio', () => {
  const snapshot = snapshotFixture()
  const zh = mountClient('zh-CN').render(readoutPresets({ snapshot, open: true }))
  assert.ok(zh.texts.includes('缓存'), 'zh cache label')
  assert.ok(zh.texts.includes('98.5%'), 'zh cache ratio')
  const en = mountClient('en-US').render(readoutPresets({ snapshot, open: true }))
  assert.ok(en.texts.includes('Cache'), 'en cache label')
  assert.ok(en.texts.includes('98.5%'), 'en cache ratio')
})

test('cache hit rate row is hidden when there are no input tokens', () => {
  const snapshot = snapshotFixture({
    today: { cacheHitRate: null, cacheHitTokens: 0, cacheMissTokens: 0 },
  })
  const zh = mountClient('zh-CN').render(readoutPresets({ snapshot, open: true }))
  assert.ok(!zh.texts.includes('缓存'), 'no cache row without a ratio')
})

test('estimate cache hit rate carries the ≈ marker', () => {
  const snapshot = snapshotFixture({
    today: {
      source: 'estimate',
      cacheHitRate: 0.5,
      officialError: 'raw host error',
      officialErrorCode: 'NETWORK',
    },
  })
  const zh = mountClient('zh-CN').render(readoutPresets({ snapshot, open: true }))
  assert.ok(zh.texts.includes('≈50.0%'), 'estimate ratio: ' + JSON.stringify(zh.texts))
})

test('zh and en dictionaries keep the same keys', () => {
  const zh = textKeys('zh')
  const en = textKeys('en')
  assert.deepEqual([...zh.topKeys].sort(), [...en.topKeys].sort())
  assert.deepEqual([...zh.errorKeys].sort(), [...en.errorKeys].sort())
  for (const key of ['title', 'balance', 'today', 'input', 'output', 'cache', 'rate', 'updated', 'aria']) {
    assert.ok(zh.topKeys.includes(key), 'missing zh key: ' + key)
  }
  assert.ok(zh.errorKeys.length >= 9, 'zh error codes are present')
  for (const code of ['NO_ACCOUNT', 'NETWORK', 'AUTH', 'HTTP', 'BODY', 'SIZE', 'SHAPE', 'NO_KEY', 'UNKNOWN']) {
    assert.ok(zh.errorKeys.includes(code), 'missing zh error code: ' + code)
  }
})

test('package manifest stays installable', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.name, 'dsh-sidebar-wallet')
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'cordis.patch.yml')), 'cordis.patch.yml exists')
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(pkg.files.includes(file), 'files entry: ' + file)
  }
  // The dev tooling and tests must never ship with the plugin.
  assert.ok(!pkg.files.some((file) => /^(test|tools)\//.test(file)), 'tests/tools stay out of the package')
  assert.ok(pkg.engines?.dsh, 'engines.dsh is declared')
})

test('locale files declare a title and a description', () => {
  for (const language of ['zh', 'en']) {
    const locale = JSON.parse(read('locale/' + language + '.json'))
    assert.equal(typeof locale.meta?.title, 'string')
    assert.ok(locale.meta.title.length > 0, language + ' title')
    assert.equal(typeof locale.meta?.description, 'string')
    assert.ok(locale.meta.description.length > 0, language + ' description')
  }
})

test('client and host agree on the module id and the route path', () => {
  assert.match(CLIENT_SOURCE, /id: 'dsh-sidebar-wallet'/)
  assert.match(CLIENT_SOURCE, /fetch\('\/dsh-sidebar-wallet\/state\.json'/)
  assert.match(HOST_SOURCE, /name = 'dsh-sidebar-wallet'/)
  assert.match(HOST_SOURCE, /path: '\/dsh-sidebar-wallet\/state\.json'/)
  assert.match(read('cordis.patch.yml'), /dsh-sidebar-wallet/)
})

test('runtime files parse', () => {
  for (const file of ['index.js', 'client.js', 'tools/preview/make-preview.mjs', 'test/client-harness.mjs']) {
    const check = spawnSync(process.execPath, ['--check', path.join(REPO_ROOT, file)], { encoding: 'utf8' })
    assert.equal(check.status, 0, file + ' failed to parse:\n' + (check.stderr || ''))
  }
})
