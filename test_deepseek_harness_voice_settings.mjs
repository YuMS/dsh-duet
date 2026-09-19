import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { VoiceSettings, validateBackendURL, settingsWriteAllowed } from './deepseek_harness_voice_settings.mjs'
import { ServiceNotices } from './deepseek_harness_voice_notices.mjs'
import { voiceConfig } from './deepseek_harness_voice_proxy.mjs'

async function fixture(t, base = voiceConfig({})) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-settings-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return new VoiceSettings(base, { path: join(dir, 'voice.json') })
}

test('default debug is off, test token is a placeholder, no secret is returned', async t => {
  const s = await fixture(t, voiceConfig({ DUPLEX_VOICE_AUTHORIZATION: 'private-secret' }))
  assert.equal(s.public().debug, false)
  assert.equal(s.public().auth_configured, true)
  assert.ok(!JSON.stringify(s.public()).includes('private-secret'))
})

test('settings are private, survive reload, and test does not send an Authorization header', async t => {
  const s = await fixture(t)
  await s.save({ revision: 0, backend_url: 'wss://example.test/ws?protocol=realtime_v2', auth_token: 'test' })
  assert.equal((await stat(s.path)).mode & 0o777, 0o600)
  assert.equal(JSON.parse(await readFile(s.path, 'utf8')).auth_token, 'test')
  const reloaded = new VoiceSettings(s.base, { path: s.path })
  assert.equal(reloaded.effective().authorization, '')
  assert.equal(reloaded.effective().endpoints.online, 'wss://example.test/ws?protocol=realtime_v2')
})

test('changing server never copies an old secret; stale saves are refused', async t => {
  const s = await fixture(t)
  await s.save({ revision: 0, backend_url: 'wss://a.test/ws', auth_token: 'secret-a' })
  await assert.rejects(s.save({ revision: 0, backend_url: 'wss://a.test/ws', auth_token: '' }), /revision/)
  await s.save({ revision: 1, backend_url: 'wss://a.test/ws', auth_token: '' })
  assert.equal(s.effective().authorization, 'secret-a')
  await s.save({ revision: 2, backend_url: 'wss://b.test/ws', auth_token: '' })
  assert.equal(s.effective().authorization, '')
})

test('explicit plaintext exception persists for one origin only and disappears on HTTPS migration', async t => {
  const s = await fixture(t)
  await assert.rejects(s.save({ revision: 0, backend_url: 'ws://public.test/ws', auth_token: 'secret' }), /requires_wss/)
  await s.save({ revision: 0, backend_url: 'ws://public.test/ws', auth_token: 'secret', allow_insecure_http: true })
  assert.equal(s.public().insecure_transport, true)
  const reloaded = new VoiceSettings(s.base, { path: s.path })
  assert.equal(reloaded.effective().endpoints.online, 'ws://public.test/ws')
  await assert.rejects(reloaded.save({ revision: 0, backend_url: 'ws://other.test/ws', auth_token: '' }), /requires_wss/)
  await reloaded.save({ revision: 0, backend_url: 'wss://public.test/ws', auth_token: '' })
  assert.equal(reloaded.public().insecure_transport, false)
  assert.equal(reloaded.effective().authorization, '')
})

test('URL and settings mutation guard reject credentials, unsafe schemes, and cross-origin requests', () => {
  for (const value of ['file:///tmp/a', 'https://example.test', 'wss://user:pass@x.test/ws', 'wss://x.test/ws?token=secret', 'ws://public.test/ws']) assert.throws(() => validateBackendURL(value))
  assert.equal(validateBackendURL('ws://127.0.0.1:28925/ws'), 'ws://127.0.0.1:28925/ws')
  const headers = { host: 'localhost:3080', origin: 'http://localhost:3080', 'content-type': 'application/json', 'x-duplex-settings': '1' }
  assert.ok(settingsWriteAllowed({ headers }))
  assert.ok(!settingsWriteAllowed({ headers: { ...headers, origin: 'https://evil.test' } }))
  assert.ok(!settingsWriteAllowed({ headers: { ...headers, 'x-duplex-settings': '' } }))
})

test('notices use a fixed derived URL, cached CPU-only fetch, and return no credential', async () => {
  let calls = 0
  const config = { endpoints: { online: 'wss://example.test/service/ws?protocol=realtime_v2' }, authorization: 'private' }
  const feed = new ServiceNotices(() => config, async (url, opts) => {
    calls++
    assert.equal(url.toString(), 'https://example.test/service/announcements')
    assert.equal(opts.headers.Authorization, 'private')
    assert.equal(opts.redirect, 'error')
    return new Response(JSON.stringify({ version: 1, items: [{ id: 'a', title: '<script>not executable</script>', body: '更新通知', level: 'update', published_at: '2026-09-14T00:00:00Z' }] }))
  })
  const [a, b] = await Promise.all([feed.get(), feed.get()])
  assert.deepEqual(a, b)
  assert.equal(a.status, 'ok')
  assert.equal(calls, 1)
  assert.ok(!JSON.stringify(a).includes('private'))
  await feed.get(); assert.equal(calls, 1)
  feed.invalidate(); await feed.get(); assert.equal(calls, 2)
})

test('missing or malformed notice endpoints do not invent empty successful feeds', async () => {
  for (const response of [new Response('not found', { status: 404 }), new Response('{"items":[]}'), new Response('x'.repeat(128001))]) {
    const feed = new ServiceNotices(() => ({ endpoints: { online: 'wss://x.test/ws' } }), async () => response)
    assert.equal((await feed.get()).status, 'unavailable')
  }
})
