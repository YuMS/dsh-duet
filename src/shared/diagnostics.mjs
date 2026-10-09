/** Only structural connection diagnostics may leave the user's DSH. */
export const DIAGNOSTICS_PROTOCOL = 'client_diagnostics_v1'
const events = new Set([
  'browser.connection_start', 'browser.connection_close', 'browser.pagehide',
  'browser.audio_prepare_started', 'browser.audio_prepare_failed', 'browser.audio_ready',
  'browser.microphone_started', 'browser.microphone_granted', 'browser.microphone_failed',
  'browser.capture_started', 'browser.capture_failed', 'browser.first_input_audio',
  'browser.server_error', 'browser.message_failed', 'browser.ws_closed', 'browser.ws_error',
  'browser.open_failed', 'proxy.failed', 'proxy.handshake_failed', 'proxy.upstream_closed',
  'proxy.browser_closed', 'proxy.first_input_audio',
])
const reasons = new Set(['user_off', 'mode_switch', 'idle_release', 'page_unload', 'unmount', 'error', 'reconnect', 'settings_changed', 'unknown'])
const names = new Set(['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'SecurityError', 'AbortError', 'InvalidStateError', 'NotSupportedError', 'TypeError', 'Error'])
export function diagnosticPayload(value) {
  if (!value || !events.has(value.event)) return null
  const out = { event: value.event }
  for (const key of ['event_id', 'client_trace_id', 'page_id']) if (typeof value[key] === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value[key])) out[key] = value[key]
  for (const key of ['plugin_version', 'host_version']) if (typeof value[key] === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value[key]) && value[key].length <= 64) out[key] = value[key]
  for (const key of ['elapsed_ms', 'buffered_bytes', 'bytes', 'context_sample_rate', 'base_latency', 'status']) if (Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1e12) out[key] = value[key]
  if (Number.isInteger(value.code) && value.code >= 1000 && value.code <= 4999) out.code = value.code
  // Never send arbitrary exception messages, stack traces, device labels or URLs.
  if (typeof value.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value.code)) out.code = value.code
  if (value.name) out.name = names.has(value.name) ? value.name : 'OtherError'
  if (value.reason) out.reason = reasons.has(value.reason) ? value.reason : 'unknown'
  for (const key of ['mode', 'mode_to']) if (['off', 'online', 'tts_only'].includes(value[key])) out[key] = value[key]
  if (['running', 'suspended', 'closed', 'interrupted'].includes(value.context_state)) out.context_state = value.context_state
  if (['visible', 'hidden'].includes(value.visibility)) out.visibility = value.visibility
  if (['permission', 'capture', 'audio_context', 'opening'].includes(value.phase)) out.phase = value.phase
  if (typeof value.was_clean === 'boolean') out.was_clean = value.was_clean
  return out
}
