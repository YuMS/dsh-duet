import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { VoiceTrace, redact } from './deepseek_harness_voice_trace.mjs'

test('private replay capture preserves audio bytes/timing and redacts credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-trace-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const trace = new VoiceTrace({ mode: 'online' }, { root, secrets: ['very-secret'] })
  trace.frame('browser.receive', Buffer.from([1, 2, 3, 4]), true)
  trace.frame('upstream.receive', JSON.stringify({ type: 'response.output_audio.delta', delta: 'BQY=', sample_rate: 24000 }))
  trace.event('failure', { authorization: 'x', stack: 'url?token=very-secret', input: 'normal text' })
  await trace.close({ code: 1000 })
  const raw = await readFile(join(trace.path, 'events.jsonl'), 'utf8')
  const rows = raw.trim().split('\n').map(JSON.parse)
  assert.ok(!raw.includes('very-secret')); assert.ok(!raw.includes('BQY='))
  assert.equal(rows.at(-1).type, 'trace.closed')
  assert.equal(rows[2].blob.offset, 4)
  assert.deepEqual(await readFile(join(trace.path, 'audio.bin')), Buffer.from([1, 2, 3, 4, 5, 6]))
  assert.ok(rows.every((row, i) => i === 0 || row.elapsed_ms >= rows[i - 1].elapsed_ms))
  assert.equal((await stat(join(trace.path, 'events.jsonl'))).mode & 0o777, 0o600)
  assert.equal((await stat(trace.path)).mode & 0o777, 0o700)
})

test('quotas mark incomplete, retain previous records, and never throw into audio', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-quota-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const trace = new VoiceTrace({}, { root, maxBytes: 2000 })
  trace.frame('browser.receive', Buffer.alloc(4000), true)
  trace.event('ignored', {})
  await trace.close()
  assert.equal(trace.snapshot().error, 'quota_exceeded')
  const rows = (await readFile(join(trace.path, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(rows.at(-1).type, 'trace.incomplete')
})

test('unwritable trace destination fails safely and is observable', async () => {
  const trace = new VoiceTrace({}, { root: '/dev/null/not-a-directory' })
  trace.event('ignored', {}); await trace.close()
  assert.equal(trace.snapshot().complete, false)
})

test('nested credentials and authentication URLs are redacted', () => {
  const v = redact({ nested: { auth_token: 's', cookie: 'c' }, link: 'https://x?token=abc&x=1', stack: 'Bearer ABC.123' })
  assert.equal(v.nested.cookie, '[REDACTED]')
  assert.ok(!v.link.includes('abc')); assert.ok(!v.stack.includes('ABC.123'))
})
