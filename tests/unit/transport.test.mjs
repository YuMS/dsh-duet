import assert from 'node:assert/strict'
import test from 'node:test'
import { voiceSocketUrl } from '../../src/client/transport.mjs'

test('Desktop voice uses the authenticated Host carrier instead of ws://app', () => {
  const result = new URL(voiceSocketUrl({ mode: 'online', page_id: 'test & page' }, {
    document: { baseURI: 'dsh-app://app/' },
    __DSH_TRANSPORT__: { streamBaseUrl: 'http://127.0.0.1:19387/' },
  }))
  assert.equal(result.origin, 'ws://127.0.0.1:19387')
  assert.equal(result.pathname, '/duplex-control/voice/ws')
  assert.equal(result.searchParams.get('page_id'), 'test & page')
})
test('Web voice preserves HTTPS and the server mount path', () => {
  assert.equal(voiceSocketUrl({ mode: 'tts_only' }, { document: { baseURI: 'https://example.test/harness/' } }),
    'wss://example.test/harness/duplex-control/voice/ws?mode=tts_only')
  assert.equal(voiceSocketUrl({}, { document: { baseURI: 'http://localhost:3080/' } }),
    'ws://localhost:3080/duplex-control/voice/ws')
})
test('Desktop without a Host carrier fails before sending to the wrong authority', () => {
  assert.throws(() => voiceSocketUrl({}, { document: { baseURI: 'dsh-app://app/' } }), /voice_transport_unavailable/)
})
