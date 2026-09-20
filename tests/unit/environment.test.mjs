import assert from 'node:assert/strict'
import test from 'node:test'
import { duetEnv } from '../../src/host/environment.mjs'
import { duetConfig } from '../../src/host/proxy.mjs'

test('duet configuration takes priority and preserves legacy overrides', () => {
  assert.equal(duetEnv('DEBUG', {DUPLEX_CONTROL_DEBUG:'1'}), '1')
  assert.equal(duetEnv('MIN_VERSION', {DUPLEX_PLUGIN_MIN_VERSION:'0.1.0'}), '0.1.0')
  assert.equal(duetEnv('AUTHORIZATION', {DUET_AUTHORIZATION:'', DUPLEX_VOICE_AUTHORIZATION:'old'}), '')
  const c = duetConfig({DUET_URL:'ws://localhost:1234/ws',DUPLEX_VOICE_URL:'ws://localhost:5678/ws'})
  assert.equal(c.endpoints.online, 'ws://localhost:1234/ws')
  assert.equal(c.endpoints.tts_only, c.endpoints.online)
  assert.equal(duetConfig({DUPLEX_VOICE_URL:'ws://localhost:5678/ws'}).endpoints.online, 'ws://localhost:5678/ws')
})
