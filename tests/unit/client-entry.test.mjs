import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../../src/client/entry.js', import.meta.url), 'utf8')

async function composerRequest({ type = 'consume', attachments = [], legacy = false, race = false, overwrite = false, stale = false, modern = false } = {}) {
  let client
  let cleanup
  let wrote = false
  let settle
  const completed = new Promise(resolve => { settle = resolve })
  const state = { draft: '保留完整输入', draftRev: 2, phase: 'plain', [legacy ? 'imageIds' : 'attachmentIds']: attachments }
  const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(state.draft))).toString('hex')
  const request = { id: 'r1', session_id: 's1', type, text: '替换正文', expected_revision: 2, expected_hash: hash, require_focus: true }
  request.overwrite = overwrite
  if (stale) { request.expected_revision = 0; request.expected_hash = '0'.repeat(64) }
  const input = {
    state: { getSnapshot: () => ({ ...state }) },
    setDraft: text => { wrote = true; state.draft = text; state.draftRev++ },
  }
  const context = {
    sessions: { refresh: async () => {}, scope: () => ({}), list: { getSnapshot: () => modern ? ({ byId: { s1: { retainedBy: { mainView: 1 } } } }) : ({ current: 's1' }) } },
    conversation: { input: { for: () => input } },
    effect: (fn, label) => { if (label.includes('bridge server composer RPC')) cleanup = fn() },
  }
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: definition => { client = definition.factory() } } },
    AbortController, TextEncoder, console,
    crypto: {
      randomUUID: () => 'test-browser',
      subtle: { digest: async (...args) => {
        const result = await webcrypto.subtle.digest(...args)
        if (race) { state.draft = '手动新输入'; state.draftRev++ }
        return result
      } },
    },
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
    fetch: async (url, options) => {
      if (url.endsWith('/complete')) settle(JSON.parse(options.body))
      return { ok: true, json: async () => url.endsWith('/claim') ? { request } : { requests: [request] } }
    },
  })
  client.apply(context)
  let timer
  try {
    const result = await Promise.race([completed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('composer RPC timed out')), 2000) })])
    return { result, state, wrote }
  } finally {
    clearTimeout(timer)
    cleanup?.()
  }
}

test('current DSH text-only consume preserves exact submitted text', async () => {
  const { result, state, wrote } = await composerRequest()
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.composer.consumed_text, '保留完整输入')
  assert.equal(state.draft, '')
  assert.equal(wrote, true)
})

test('mainView selection supports composer writes and send validation', async () => {
  const edit = await composerRequest({ modern: true, type: 'set', overwrite: true })
  assert.equal(edit.result.ok, true)
  assert.equal(edit.state.draft, '替换正文')
  const send = await composerRequest({ modern: true })
  assert.equal(send.result.ok, true)
  assert.equal(send.result.composer.consumed_text, '保留完整输入')
})

for (const legacy of [false, true]) {
  test(`attachment send is refused without clearing text (${legacy ? 'imageIds' : 'attachmentIds'})`, async () => {
    const { result, state, wrote } = await composerRequest({ attachments: ['browser-owned-file'], legacy })
    assert.equal(result.ok, false)
    assert.equal(result.error_code, 'composer_attachments_unsupported')
    assert.equal(state.draft, '保留完整输入')
    assert.equal(wrote, false)
  })
}

test('editing text keeps browser-owned attachments', async () => {
  const { result, state } = await composerRequest({ type: 'set', attachments: ['file'] })
  assert.equal(result.ok, true)
  assert.equal(state.draft, '替换正文')
  assert.deepEqual(state.attachmentIds, ['file'])
})

test('read-modify-write still rejects typing while hashing the snapshot', async () => {
  const { result, state, wrote } = await composerRequest({ type: 'set', race: true })
  assert.equal(result.ok, false)
  assert.equal(result.error_code, 'draft_conflict')
  assert.equal(state.draft, '手动新输入')
  assert.equal(wrote, false)
})

test('host bridge supports explicit overwrite without disabling send validation', async () => {
  const edit = await composerRequest({ type: 'set', overwrite: true, stale: true })
  assert.equal(edit.result.ok, true)
  assert.equal(edit.state.draft, '替换正文')
  const send = await composerRequest({ type: 'consume', overwrite: true, stale: true })
  assert.equal(send.result.error_code, 'draft_conflict')
  assert.equal(send.wrote, false)
})

for (const modern of [true, false]) {
  test(`host focus opens the visible DSH conversation (${modern ? 'UI navigation' : 'legacy'})`, async () => {
    let client, cleanup, selected = null, uiOpened = null, settle
    const opened = new Promise(resolve => { settle = resolve })
    const sessions = {
      refresh: async () => {},
      open: id => { selected = id; settle() },
      list: { getSnapshot: () => ({ current: selected, byId: { s1: {} } }), subscribe: () => () => {} },
    }
    const context = {
      sessions,
      get: () => modern ? { openSession: id => { uiOpened = id; sessions.open(id) } } : undefined,
      effect: (fn, label) => { if (label.includes('synchronize host and browser focus')) cleanup = fn() },
    }
    vm.runInNewContext(source, {
      window: { __ModuleLoader__: { load: definition => { client = definition.factory() } } },
      AbortController, console, crypto: webcrypto,
      setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
      document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
      fetch: async () => ({ ok: true, json: async () => ({ session_id: 's1', revision: 1, focus_epoch: 'epoch1' }) }),
    })
    client.apply(context)
    let timer
    try {
      await Promise.race([opened, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('focus timeout')), 2000) })])
      assert.equal(selected, 's1')
      assert.equal(uiOpened, modern ? 's1' : null)
    } finally { clearTimeout(timer); cleanup?.() }
  })
}

test('hidden composer bridge re-arms long poll without intervals and recovers hung fetch', async () => {
  let client, cleanup, finishPoll
  const timers = new Map(), urls = []
  let nextTimer = 0
  const context = {
    sessions: { list: { getSnapshot: () => ({ current: 's1' }) } },
    effect: (fn, label) => { if (label.includes('bridge server composer RPC')) cleanup = fn() },
  }
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: d => { client = d.factory() } } },
    AbortController, TextEncoder, crypto: webcrypto, console: { warn() {} },
    document: { visibilityState: 'hidden', addEventListener() {}, removeEventListener() {} },
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id },
    clearTimeout: id => timers.delete(id),
    setInterval: () => { throw new Error('composer bridge must not depend on background timers') },
    clearInterval() {},
    fetch: (url, options) => new Promise((resolve, reject) => {
      urls.push(url)
      finishPoll = () => resolve({ ok: true, json: async () => ({ requests: [], long_poll_supported: true }) })
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }),
  })
  const flush = () => new Promise(resolve => setImmediate(resolve))
  client.apply(context)
  try {
    assert.equal(urls.length, 1)
    assert.match(urls[0], /wait=1.*session_id=s1.*visibility=hidden/)
    finishPoll()
    await flush()
    assert.equal(urls.length, 2, 'successful response immediately re-arms a pending poll')
    const timeout = [...timers.values()].find(t => t.ms === 30_000)
    timeout.fn()
    await flush()
    const retry = [...timers.values()].find(t => t.ms === 1000)
    assert.ok(retry, 'aborted network request schedules reconnect')
    retry.fn()
    await flush()
    assert.equal(urls.length, 3)
  } finally { cleanup(); await flush() }
  assert.equal(timers.size, 0)
})
