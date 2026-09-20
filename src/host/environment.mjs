/** Prefer duet names while accepting existing installations' environment keys. */
const legacyNames = {
  MIN_VERSION: 'DUPLEX_PLUGIN_MIN_VERSION',
  MAX_VERSION_EXCLUSIVE: 'DUPLEX_PLUGIN_MAX_VERSION_EXCLUSIVE',
  DEBUG: 'DUPLEX_CONTROL_DEBUG',
}

export function duetEnv(name, env = process.env) {
  return env[`DUET_${name}`] ?? env[legacyNames[name] ?? `DUPLEX_VOICE_${name}`]
}
