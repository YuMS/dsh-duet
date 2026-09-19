import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeInteractions } from './deepseek_harness_voice_interactions.mjs'

test('native question list and voice answer settle the same clickable carrier', async () => {
  const map = new Map(), answers = []
  const question = { key: 'question:5', kind: 'question', sessionId: 's1',
    questions: [{ id: 'q1', question: '用哪种颜色？', options: [{ label: '蓝色' }] }],
    answer: async value => { answers.push(value); map.delete('s1') } }
  map.set('s1', question)
  const call = nativeInteractions({ uiSession: { pendingInteractions: { getSnapshot: () => map } } })
  const listed = await call({ method: 'GET', path: '/api/interactions' })
  assert.equal(listed.interactions[0].id, question.key)
  assert.deepEqual(listed.interactions[0].questions, question.questions)
  assert.equal('answer' in listed.interactions[0], false)
  const request = { method: 'POST', path: '/api/interactions/question%3A5/respond', payload: { answers: [{ id: 'q1', selected: ['蓝色'] }] } }
  assert.equal((await call(request)).ok, true)
  assert.deepEqual(answers, [{ answers: request.payload.answers }])
  await assert.rejects(call(request), /interaction_already_finished/)
  assert.equal(answers.length, 1)
})

test('approval uses native answer; native cancellation and page click remove stale requests', async () => {
  let answer
  const map = new Map([['s1', { key: 'approval:1', kind: 'approval', sessionId: 's1', toolName: 'bash',
    answer: async value => { answer = value; map.delete('s1') } }]])
  const call = nativeInteractions({ uiSession: { pendingInteractions: { getSnapshot: () => map } } })
  await assert.rejects(call({ method: 'POST', path: '/api/interactions/approval%3A1/respond', payload: { outcome: 'anything' } }), /invalid_approval/)
  await call({ method: 'POST', path: '/api/interactions/approval%3A1/respond', payload: { outcome: 'rejected' } })
  assert.equal(answer, 'rejected')
  assert.deepEqual((await call({ method: 'GET', path: '/api/interactions' })).interactions, [])
})
