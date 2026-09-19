import assert from 'node:assert/strict'
import test from 'node:test'
import { AUDIO_CONSENT_KEY, createAudioUploadConsent } from './deepseek_harness_voice_consent.mjs'

test('previous mode-specific permissions do not bypass unified consent', () => {
  const stored = new Map(['dsh-duet.audio-upload-consent.v2', 'dsh-duet.broadcast-upload-consent.v1'].map(key => [key, 'accepted']))
  assert.equal(createAudioUploadConsent({ getItem: key => stored.get(key) }).granted(), false)
})
test('tutorial consent respects an already aborted signal', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(createAudioUploadConsent(null).ensure(controller.signal), { name: 'AbortError' })
})

test('audio-only consent does not grant the expanded session-context permission', () => {
  const stored = new Map([['dsh-duet.audio-upload-consent.v1', 'accepted']])
  assert.equal(createAudioUploadConsent({ getItem: key => stored.get(key) }).granted(), false)
})

test('only the explicit current consent value permits interaction', () => {
  for (const value of [null, 'true', 'declined', 'accepted']) {
    const consent = createAudioUploadConsent({ getItem(key) { assert.equal(key, AUDIO_CONSENT_KEY); return value } })
    assert.equal(consent.granted(), value === 'accepted')
  }
})
test('blocked browser storage is not implicitly consent', () => {
  assert.equal(createAudioUploadConsent({ getItem() { throw Error('blocked') } }).granted(), false)
  assert.equal(createAudioUploadConsent(null).granted(), false)
})
test('remembered consent runs the user action without a new dialog', () => {
  let count = 0
  const consent = createAudioUploadConsent({ getItem() { return 'accepted' } })
  consent.request(() => count++)
  assert.equal(count, 1)
})
