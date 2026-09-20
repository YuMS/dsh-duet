import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeInteractions } from '../../src/client/interactions.mjs'
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
