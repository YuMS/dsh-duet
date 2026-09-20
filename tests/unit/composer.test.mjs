import assert from 'node:assert/strict'
import test from 'node:test'
import { webcrypto } from 'node:crypto'
import { ComposerPublisher, composerAccess, focusedSession } from '../../src/client/composer.mjs'
import { HarnessRPCExecutor } from '../../src/client/rpc.mjs'
globalThis.crypto ??= webcrypto
const settle = () => new Promise(resolve => setImmediate(resolve))

test('focus follows the main conversation, not background references', () => {
  let snapshot = { current: 'old' }
  const ctx = { sessions: { list: { getSnapshot: () => snapshot } } }
  assert.equal(focusedSession(ctx), 'old')
  snapshot = { byId: { background: { retainedBy: { sidebar: 1 } }, chosen: { retainedBy: { mainView: 1 } } } }
  assert.equal(focusedSession(ctx), 'chosen')
  snapshot.byId.next = { retainedBy: { mainView: 1 } }
  assert.equal(focusedSession(ctx), null)
  snapshot = { byId: {} }
  assert.equal(focusedSession(ctx), null)
})

test('browser timer helpers are called without a class-instance receiver', () => {
  const pub = new ComposerPublisher(async () => null, () => {}, {
    later: function () { assert.equal(this, undefined); return 1 },
    cancel: function () { assert.equal(this, undefined) },
    now: function () { assert.equal(this, undefined); return 0 },
  })
  pub.changed(); pub.close()
})

test('continuous typing is leading/trailing throttled, never debounced indefinitely', async () => {
  let now = 0, timer, text = 'a'
  const messages = [], times = []
  const pub = new ComposerPublisher(async () => ({ text }), msg => { messages.push(msg); times.push(now) }, {
    now: () => now, later: (fn, ms) => { timer = { fn, at: now + ms }; return timer },
    cancel: value => { if (value === timer) timer = null },
  })
  const advance = async time => {
    now = time
    if (timer && timer.at <= now) { const fn = timer.fn; timer = null; fn(); await settle() }
  }
  pub.changed(); await advance(0)
  for (let i = 1; i <= 50; i++) {
    now = i * 100; text = String(i); pub.changed(); await advance(now)
  }
  assert.deepEqual(times, [0, 2000, 4000])
  await advance(6000)
  assert.equal(messages.at(-1).composer.text, '50')
  assert.deepEqual(times, [0, 2000, 4000, 6000])
  now = 6100; text = 'new session'; pub.changed({ focus: true }); await advance(now)
  assert.equal(messages.at(-1).composer.text, 'new session')
  pub.changed(); pub.close(); await advance(9000)
  assert.equal(messages.length, 5)
})

test('late asynchronous read cannot overwrite a focus change or survive close', async () => {
  let finish
  const messages = []
  const pub = new ComposerPublisher(() => new Promise(resolve => { finish = resolve }), x => messages.push(x))
  const pending = pub.publish()
  pub.changed({ focus: true }); pub.close(); finish({ text: 'old' })
  await pending
  assert.deepEqual(messages, [])
})

function fixture() {
  let focus = 'a'
  const values = new Map(['a', 'b'].map(id => [id, { draft: id, draftRev: 1, phase: 'plain' }]))
  const inputFor = id => ({ state: { getSnapshot: () => values.get(id) },
    setDraft: draft => values.set(id, { ...values.get(id), draft, draftRev: values.get(id).draftRev + 1 }) })
  const ctx = { sessions: { list: { getSnapshot: () => ({ current: focus }) }, scope: id => id },
    conversation: { input: { for: inputFor } } }
  return { access: composerAccess(ctx), values, focus: id => { focus = id } }
}
const write = before => ({ method: 'PUT', path: '/api/sessions/a/composer', payload: {
  expected_revision: before.revision, expected_hash: before.hash, text: '新内容', require_focus: true,
} })

test('local write checks manual edits, focus and phase; returns authoritative state', async () => {
  const f = fixture(), before = await f.access.read()
  f.values.set('a', { draft: '手改', draftRev: 2, phase: 'plain' })
  await assert.rejects(f.access.execute(write(before)), /draft_conflict/)
  assert.equal(f.values.get('a').draft, '手改')
  const latest = await f.access.read()
  f.focus('b'); await assert.rejects(f.access.execute(write(latest)), /focus_conflict/)
  f.focus('a')
  const result = await f.access.execute(write(latest))
  assert.equal(result.composer.text, '新内容')
  assert.equal(result.composer.revision, 3)
  f.values.get('a').phase = 'sending'
  await assert.rejects(f.access.execute(write(result.composer)), /composer_busy/)
})

test('focused cache miss and local write use no host HTTP; duplicate write executes once', async () => {
  const f = fixture(), messages = []
  const executor = new HarnessRPCExecutor(x => messages.push(x), () => { throw Error('unexpected HTTP') }, () => {}, f.access.execute)
  const base = { type: 'harness.rpc.request', connection_id: 'a'.repeat(32), request_id: 'b'.repeat(32) }
  await executor.execute({ ...base, method: 'GET', path: '/api/composer/focused' })
  const request = { ...base, request_id: 'c'.repeat(32), ...write(messages[0].body.composer) }
  await executor.execute(request); await executor.execute(request)
  assert.equal(f.values.get('a').draftRev, 2)
  assert.equal(messages[1].status, 200)
  assert.deepEqual(messages[1], messages[2])
  executor.close()
})

test('explicit overwrite ignores stale version/hash but keeps focus and connection guards', async () => {
  const f = fixture(), before = await f.access.read()
  f.values.set('a', { draft: '用户后续输入', draftRev: 9, phase: 'plain' })
  const request = write(before)
  request.payload.overwrite = true
  f.focus('b')
  await assert.rejects(f.access.execute(request), /focus_conflict/)
  assert.equal(f.values.get('a').draft, '用户后续输入')
  f.focus('a')
  const stop = new AbortController(); stop.abort()
  await assert.rejects(f.access.execute(request, stop.signal), /abort/i)
  const result = await f.access.execute(request)
  assert.equal(result.composer.text, '新内容')
  assert.equal(f.values.get('a').draftRev, 10)
  request.payload.text = ''
  delete request.payload.expected_hash; delete request.payload.expected_revision
  assert.equal((await f.access.execute(request)).composer.text, '')
})
