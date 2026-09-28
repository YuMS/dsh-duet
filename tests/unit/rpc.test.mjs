import assert from 'node:assert/strict'
import test from 'node:test'
import { HarnessRPCExecutor, validateRPC, rpcNavigationSession } from '../../src/client/rpc.mjs'
import { sessionCreationPayload } from '../../src/client/workspaces.mjs'

const message = extra => ({ type: 'harness.rpc.request', connection_id: 'a'.repeat(32),
  request_id: 'b'.repeat(32), method: 'GET', path: '/api/sessions', ...extra })

test('creation follows page workspace at command time, rejects missing selection, and ignores remote cwd', async () => {
  let current = 's2'
  const ctx = { sessions: { list: { getSnapshot: () => ({current}) } },
    workspaces: { list: { getSnapshot: () => ({ phase: 'ready', items: [
      { workspaceId: 'ws1', sessionIds: ['s1'] }, { workspaceId: 'ws2', sessionIds: ['s2'] },
    ] }) } } }
  const sent = [], replies = []
  const rpc = new HarnessRPCExecutor(r => replies.push(r), async (_url, options) => {
    sent.push(JSON.parse(options.body))
    return new Response('{"session":{"session_id":"new"}}', {status: 201})
  }, undefined, null, undefined, { creationPayload: p => sessionCreationPayload(ctx, p) })
  const request = message({ method: 'POST', payload: { name: '新会话', cwd: '/wrong', workspace_id: 'wrong' } })
  await rpc.execute(request)
  current = 's1'
  await rpc.execute(request) // duplicate must not create again in another workspace
  await rpc.execute({...request, request_id: 'c'.repeat(32)})
  current = null
  await rpc.execute({...request, request_id: 'd'.repeat(32)})
  assert.deepEqual(sent, [{ name: '新会话', workspace_id: 'ws2' }, { name: '新会话', workspace_id: 'ws1' }])
  assert.equal(replies.at(-1).body.error_code, 'workspace_selection_required')
  rpc.close()
})

test('catalog advertises browser RPC creation support without changing sessions', async () => {
  const replies = []
  const rpc = new HarnessRPCExecutor(r => replies.push(r), async () =>
    new Response(JSON.stringify({sessions: [{session_id:'a',label:'A'}]})), undefined, null, rows => rows)
  await rpc.execute(message())
  assert.deepEqual(replies[0].body.duet_rpc_capabilities, ['create_session_v1'])
  assert.equal(replies[0].body.sessions[0].label, 'A')
  rpc.close()
})

test('create session executes once and navigates before returning its 201 response', async () => {
  const order = [], replies = []
  const payload = { name: '灵感笔记' }
  const rpc = new HarnessRPCExecutor(reply => { replies.push(reply); order.push('reply') }, async (url, options) => {
    assert.equal(url, '/duplex-control/api/sessions')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers['X-Duet-Browser-Client'], 'owner-a')
    assert.deepEqual(JSON.parse(options.body), payload)
    order.push('create')
    return new Response(JSON.stringify({ session: { session_id: 'new-session', label: payload.name } }), { status: 201 })
  }, undefined, null, undefined, { id: 'owner-a', completed: async (request, body) => {
    assert.equal(rpcNavigationSession(request, body), 'new-session')
    order.push('navigate')
  } })
  const request = message({ method: 'POST', payload })
  await Promise.all([rpc.execute(request), rpc.execute(request)])
  assert.deepEqual(order, ['create', 'navigate', 'reply', 'reply'])
  assert.equal(replies[0].status, 201)
  assert.deepEqual(replies[0], replies[1])
  rpc.close()
})

test('failed creation does not navigate, and creation does not widen other RPC routes', async () => {
  const replies = []
  const rpc = new HarnessRPCExecutor(reply => replies.push(reply), async () =>
    new Response('{"error_code":"workspace_resolution_failed"}', { status: 502 }), undefined, null, undefined,
    { completed: () => assert.fail('failed creation must not navigate') })
  await rpc.execute(message({ method: 'POST', payload: { name: '新会话' } }))
  assert.equal(replies[0].body.error_code, 'workspace_resolution_failed')
  for (const path of ['/api/sessions/', '/api/sessions?name=x', '/api/sessions/../admin', '/api/sessions/abc']) {
    assert.throws(() => validateRPC(message({ method: 'POST', path })), /route_not_allowed/)
  }
  for (const method of ['PUT', 'DELETE', 'PATCH']) assert.throws(() => validateRPC(message({ method })), /route_not_allowed/)
  assert.equal(rpcNavigationSession(message(), { session: { session_id: 'wrong' } }), null)
  assert.equal(rpcNavigationSession(message({ method: 'POST', path: '/api/sessions/a/rename' }), { session: { session_id: 'a' } }), null)
  assert.equal(rpcNavigationSession(message({ method: 'POST', path: '/api/sessions/a/activate' }), { active_session_id: 'a' }), 'a')
  assert.equal(rpcNavigationSession(message({ method: 'POST', path: '/api/sessions/a/fork' }), { session: { session_id: 'b' } }), 'b')
  rpc.close()
})

test('connection identity accompanies HTTP mutations and navigation finishes before reply', async () => {
  const order=[]
  const rpc=new HarnessRPCExecutor(() => order.push('reply'), async (_url, options) => {
    assert.equal(options.headers['X-Duet-Browser-Client'],'owner-a')
    order.push('host');return new Response(JSON.stringify({active_session_id:'s2'}))
  }, undefined, null, undefined, {id:'owner-a',completed:async (_request, body) => {
    assert.equal(body.active_session_id,'s2');order.push('local-navigation')
  }})
  await rpc.execute(message({method:'POST',path:'/api/sessions/s2/activate'}))
  assert.deepEqual(order,['host','local-navigation','reply']);rpc.close()
})

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
