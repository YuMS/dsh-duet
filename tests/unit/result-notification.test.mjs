import assert from 'node:assert/strict'
import test from 'node:test'
import { broadcastText, resultNotification, taskErrorText, LONG_RESULT_NOTICE } from '../../src/shared/result-notification.mjs'
import { externalWithState } from '../../src/host/proxy.mjs'

test('task errors keep readable messages without stringifying response objects', () => {
  for (const error of ['服务拒绝请求', new Error('服务拒绝请求'),
    { message: '服务拒绝请求', code: 'UNKNOWN' },
    { error: { message: '服务拒绝请求' } }, { cause: new Error('服务拒绝请求') }]) {
    assert.equal(taskErrorText(error), '服务拒绝请求')
    assert.equal(resultNotification({id:'j',session_id:'s',status:'failed',error}, '工作').text, '服务拒绝请求')
  }
  const circular = {}; circular.cause = circular
  for (const error of [circular, null, {}, '[object Object]',
    { message: {}, headers: { Authorization: 'private' }, stack: 'private' }]) {
    assert.equal(taskErrorText(error), '任务执行失败，请在 DSH 中查看详情。')
  }
})

test('oversized results become bounded notices before WebSocket serialization, never partial code summaries', () => {
  for (const status of ['succeeded', 'failed']) {
    const job = { id: 'job', session_id: 'session-id', status, result: '字'.repeat(2_000_000), error: '' }
    const result = resultNotification(job, 'session-id')
    assert.equal(result.text, LONG_RESULT_NOTICE)
    assert.equal(result.source.status, status === 'succeeded' ? 'completed' : 'failed')
    assert.equal(result.source.session_name, '未命名会话')
    assert.equal(result.source.session_id, 'session-id')
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1000)
    assert.equal(job.result.length, 2_000_000)
  }
})

test('normal text stays intact; proxy also bounds results from older clients', () => {
  assert.equal(broadcastText('字'.repeat(8000)), '字'.repeat(8000))
  assert.equal(broadcastText('字'.repeat(8001)), LONG_RESULT_NOTICE)
  const source = { session_id: 's1', session_name: 's1', job_id: 'j1', status: 'failed' }
  const result = externalWithState({ type: 'external_message', message_id: 'm1', text: 'x'.repeat(8001), source })
  assert.equal(result.text, LONG_RESULT_NOTICE)
  assert.equal(result.source.session_name, '未命名会话')
  assert.equal(result.source.status, 'failed')
  assert.equal(source.session_name, 's1')
  assert.equal(resultNotification({id:'j',session_id:'s',status:'failed',error:'权限不足'}, '工作').text, '权限不足')
})
