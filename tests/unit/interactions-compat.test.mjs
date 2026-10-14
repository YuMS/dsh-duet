import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeInteractions } from '../../src/client/interactions.mjs'
test('rc.2 cancellation never mistakes hiding a question for cancelling it', async () => {
  let cancelled = 0
  const question = {key:'question:im:wecom_fixture:dm:123:user:call_1',sessionId:'im:wecom_fixture:dm:123:user',
    kind:'question',questions:[],dismissal:'cancel',dismiss:async()=>{cancelled++}}
  const invoke = nativeInteractions({uiSession:{sessionStatus:{getSnapshot:()=>new Map([['s',{pendingInteraction:question}]])}}})
  const request = {method:'POST',path:`/api/interactions/${encodeURIComponent(question.key)}/respond`,payload:{cancelled:true}}
  assert.equal((await invoke(request)).ok,true)
  assert.equal(cancelled,1)
  question.dismissal='hide'
  await assert.rejects(invoke(request), {code:'question_cancel_unavailable'})
  assert.equal(cancelled,1)
})
for (const modern of [false, true]) test(`pending question catalog and response on DSH ${modern ? '0.1.6' : '0.1.5'}`, async () => {
  let result
  const question = { key: 'question:1', sessionId: 's', kind: 'question', questions: [{ id: 'q', question: '选什么？' }], answer: async value => { result = value } }
  const uiSession = modern
    ? { sessionStatus: { getSnapshot: () => new Map([['s', { pendingInteraction: question }], ['other', {}]]) } }
    : { pendingInteractions: { getSnapshot: () => new Map([['s', question]]) } }
  const invoke = nativeInteractions({ uiSession })
  const signal = new AbortController().signal
  const catalog = await invoke({ method: 'GET', path: '/api/interactions' }, signal)
  assert.equal(catalog.interactions.length, 1)
  assert.equal(catalog.interactions[0].id, question.key)
  const payload = { answers: [{ id: 'q', selected: ['A'] }] }
  assert.equal((await invoke({ method: 'POST', path: '/api/interactions/question%3A1/respond', payload }, signal)).ok, true)
  assert.deepEqual(result, payload)
})
