import assert from 'node:assert/strict'
import test from 'node:test'
import { HarnessRPCExecutor, validateRPC } from '../../src/client/rpc.mjs'

const message = extra => ({ type: 'harness.rpc.request', connection_id: 'a'.repeat(32),
  request_id: 'b'.repeat(32), method: 'GET', path: '/api/sessions', ...extra })

test('real question/approval IDs including URL-encoded colon execute once', async () => {
  for (const kind of ['question', 'approval']) for (const colon of [':', '%3A', '%3a']) {
    const calls = [], replies = []
    const rpc = new HarnessRPCExecutor(r => replies.push(r), async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) }); return new Response('{"ok":true}')
    })
    const path = `/api/interactions/${kind}${colon}${'c'.repeat(32)}/respond`
    const payload = kind === 'question' ? { answers: [{ id: 'goal', text: '省显存' }] } : { outcome: 'allowed-once' }
    await rpc.execute(message({ method: 'POST', path, payload }))
    assert.equal(calls[0].url, '/duplex-control' + path)
    assert.deepEqual(calls[0].body, payload)
    assert.equal(replies[0].status, 200)
    rpc.close()
  }
  for (const id of ['question%253Aabc', 'question%3A..%2Fadmin', 'other:abc', 'question:abc?x=1']) {
    assert.throws(() => validateRPC(message({ method: 'POST', path: `/api/interactions/${id}/respond` })))
  }
})

test('fetch is not invoked with the executor as receiver', async () => {
  const replies = []
  const rpc = new HarnessRPCExecutor(r => replies.push(r), async function () {
    assert.equal(this, undefined, 'native browser fetch requires a plain call')
    return new Response('{}', { status: 200 })
  })
  await rpc.execute(message())
  assert.equal(replies[0].status, 200)
  rpc.close()
})

test('RPC is fixed-origin, supports strict composer reads, and sends local auth only', async () => {
  const calls = [], replies = []
  const rpc = new HarnessRPCExecutor(r => replies.push(r), async (url, options) => {
    calls.push({ url, options })
    return new Response(JSON.stringify({ composer: { text: 'local draft' } }), { status: 200 })
  })
  await rpc.execute(message({ path: '/api/sessions/alice/composer', params: { require_focus: 'true' } }))
  assert.equal(calls[0].url, '/duplex-control/api/sessions/alice/composer?require_focus=true')
  assert.equal(calls[0].options.credentials, 'same-origin')
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(calls[0].options.headers.Authorization, undefined)
  assert.equal(replies[0].body.composer.text, 'local draft')
  rpc.close()
})

test('mutation duplicates execute once; modified payload and cross-connection reuse fail', async () => {
  let calls = 0
  const rpc = new HarnessRPCExecutor(() => {}, async () => {
    calls++; return new Response('{}', { status: 200 })
  })
  const m = message({ method: 'PUT', path: '/api/sessions/alice/composer', payload: { text: 'new', expected_revision: 1 } })
  await Promise.all([rpc.execute(m), rpc.execute(m)])
  assert.equal(calls, 1)
  await assert.rejects(rpc.execute({ ...m, payload: { text: 'different' } }), /id_reused/)
  await assert.rejects(rpc.execute({ ...m, connection_id: 'c'.repeat(32) }), /wrong_connection/)
  rpc.close()
})

test('only scoped DSH control routes can execute, never URLs or traversal', () => {
  for (const path of ['http://other/api/sessions', '//other/api/sessions', '/api/sessions/../secret', '/api/sessions/a%2fb/composer', '/api/admin', '/api/sessions/a/composer?x=y']) {
    assert.throws(() => validateRPC(message({ path })))
  }
  assert.throws(() => validateRPC(message({ params: { url: 'http://other' } })))
  assert.throws(() => validateRPC(message({ path: '/api/results', params: { after: -1 } })))
  assert.throws(() => validateRPC(message({ method: 'DELETE' })))
})

test('manual edit conflict is preserved; failures never become success', async () => {
  const replies = []
  const rpc = new HarnessRPCExecutor(r => replies.push(r), async () =>
    new Response(JSON.stringify({ error_code: 'draft_conflict' }), { status: 409 }))
  await rpc.execute(message({ method: 'PUT', path: '/api/sessions/a/composer', payload: { text: 'new' } }))
  assert.equal(replies[0].status, 409)
  assert.equal(replies[0].body.error_code, 'draft_conflict')
  rpc.close()
})

test('closed connection aborts in-flight local fetch and sends no late reply', async () => {
  const replies = []
  let aborted = false
  const rpc = new HarnessRPCExecutor(r => replies.push(r), (_url, options) =>
    new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })))
  const task = rpc.execute(message())
  rpc.close()
  await task
  assert.equal(aborted, true)
  assert.deepEqual(replies, [])
})
