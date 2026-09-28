import test from 'node:test'
import assert from 'node:assert/strict'
import { DuetState, PLUGIN_VERSION, compatibilityNotice } from '../../src/shared/state.mjs'

test('mode upgrade is actionable and never silently switches mode', async () => {
  const notices = [], connections = []
  const state = new DuetState({ notice: (...v) => notices.push(v), connect: mode => {
    connections.push(mode); return { close() {}, sendState() {} }
  } })
  await state.setMode('online')
  state.receive({ type: 'error', code: 'plugin_upgrade_required', compatibility: {
    modes: { online: { min_client_version: '0.9.99', available: false }, tts_only: { available: true } }
  } })
  assert.equal(state.mode, 'off')
  assert.deepEqual(connections, ['online'])
  assert.ok(notices[0][0].includes(PLUGIN_VERSION))
  assert.ok(notices[0][0].includes('0.9.99'))
  assert.ok(notices[0][0].includes('手动开启播报模式'))
  assert.equal(notices[0][1].upgrade, true)
  await state.dispose()
})

test('old server error works and untrusted version text is never rendered', () => {
  assert.match(compatibilityNotice('plugin_upgrade_required'), /请升级插件/)
  assert.match(compatibilityNotice('plugin_upgrade_required', { policy: { min_client_version: '0.9.99' } }), /0.9.99/)
  assert.ok(!compatibilityNotice('plugin_upgrade_required', { policy: { min_client_version: '<script>bad</script>' } }).includes('<script>'))
})

test('recommendation is nonblocking and appears once per connection', async () => {
  const notices = []
  const state = new DuetState({ notice: (...v) => notices.push(v), connect: () => ({ close() {}, sendState() {} }) })
  await state.setMode('tts_only')
  for (let i = 0; i < 2; i++) state.receive({ type: 'compatibility', compatibility: { recommended_client_version: '0.9.99' } })
  assert.equal(notices.length, 1)
  assert.equal(state.mode, 'tts_only')
  state.receive({ type: 'compatibility', compatibility: { recommended_client_version: '0.0.99' } })
  assert.equal(notices.length, 1)
  await state.dispose()
})

test('recommendation returns after reopening, switching modes, or reconnecting', async () => {
  const notices = [], connections = []
  const state = new DuetState({ notice: (...v) => notices.push(v), connect: (mode, receive) => {
    const connection = { mode, receive, close() {}, sendState() {} }
    connections.push(connection)
    return connection
  } })
  const compatibility = { type: 'compatibility', compatibility: { recommended_client_version: '0.9.99' } }
  const check = count => {
    const current = connections.at(-1)
    current.receive(compatibility)
    current.receive(compatibility)
    current.receive({ type: 'ready' })
    assert.equal(notices.length, count)
    assert.equal(state.ready, true)
    assert.equal(state.connection, current)
    assert.equal(state.mode, current.mode)
    assert.equal(notices.at(-1)[1].upgrade, true)
  }
  await state.setMode('tts_only')
  check(1)
  await state.setMode('off')
  await state.setMode('tts_only')
  // Late events from the previous connection must not consume the new reminder.
  connections[0].receive(compatibility)
  assert.equal(notices.length, 1)
  check(2)
  await state.setMode('online')
  check(3)
  await state.replaceConnection()
  check(4)
  await state.setMode('online')
  assert.equal(connections.length, 4)
  assert.equal(notices.length, 4)
  await state.dispose()
})
