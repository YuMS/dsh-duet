import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { publicAsset } from '../../src/host/assets.mjs'

test('public client and shared modules exist and expose no host files', async () => {
  for (const path of ['client/browser', 'client/tutorial-adapter', 'shared/state', 'shared/catalog']) {
    const asset = publicAsset(`/duet/assets/${path}.mjs`)
    assert.ok((await readFile(asset.url, 'utf8')).length)
  }
  for (const path of ['/duet/assets/host/settings.mjs', '/duet/assets/client/../../host/proxy.mjs',
    '/duet/assets/client/entry.js', '/duplex-control/deepseek_harness_voice_proxy.mjs',
    '/duplex-control/deepseek_harness_voice___proto__.mjs']) assert.equal(publicAsset(path), null)
})

test('old browser module URLs preserve renamed exports without exposing host modules', () => {
  assert.match(publicAsset('/duplex-control/deepseek_harness_voice_state.mjs').body, /DuetState as VoiceState/)
  assert.match(publicAsset('/duplex-control/deepseek_harness_voice_browser.mjs').body, /mountDuet as mountVoice/)
  assert.match(publicAsset('/duplex-control/deepseek_harness_voice_tutorial_adapter.mjs').body, /client\/tutorial-adapter.mjs/)
})
