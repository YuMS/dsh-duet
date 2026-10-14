import { IDENTITY_HEADER, IDENTITY_TRANSPORT_HEADER, IDENTITY_TRANSPORT, IDENTITY_STORAGE,
  VOICE_PROTOCOL, IDENTITY_PROTOCOL_PREFIX, validIdentityToken } from '../shared/identity.mjs?v=0.1.10'

/** Desktop strips plugin cookies. Keep the Host-signed value in its origin storage. */
export function createIdentityClient(globals = globalThis) {
  const desktop = () => globals.location?.protocol === 'dsh-app:'
  const read = () => {
    const token = globals.localStorage.getItem(IDENTITY_STORAGE)
    return validIdentityToken(token) ? token : null
  }
  async function fetchIdentity(path, options = {}) {
    if (!desktop()) return globals.fetch(path, options)
    if (!['/duplex-control/api/voice/config', '/duplex-control/api/feedback'].includes(path)) {
      return globals.fetch(path, options)
    }
    const config = path.endsWith('/voice/config') && (!options.method || options.method === 'GET')
    const request = async () => {
      const headers = new Headers(options.headers)
      const token = read()
      if (token) headers.set(IDENTITY_HEADER, token)
      headers.set(IDENTITY_TRANSPORT_HEADER, IDENTITY_TRANSPORT)
      const response = await globals.fetch(path, {...options, headers, credentials:'same-origin', cache:'no-store'})
      if (config && response.ok) {
        const payload = await response.clone().json()
        if (payload.feedback_enabled) {
          if (!validIdentityToken(payload.feedback_identity)) throw Error('feedback_identity_unavailable')
          globals.localStorage.setItem(IDENTITY_STORAGE, payload.feedback_identity)
        }
      }
      return response
    }
    // Re-read storage inside the shared lock: concurrent page/iframe bootstrap
    // must reuse the first issued identity instead of overwriting each other.
    if (config) {
      if (!globals.navigator?.locks) throw Error('feedback_identity_lock_unavailable')
      return globals.navigator.locks.request(IDENTITY_STORAGE, {signal:options.signal}, request)
    }
    return request()
  }
  function voiceProtocols() {
    if (!desktop()) return []
    const token = read()
    return token ? [VOICE_PROTOCOL, IDENTITY_PROTOCOL_PREFIX + token] : []
  }
  return {fetch:fetchIdentity, voiceProtocols}
}

const client = createIdentityClient()
export const identityFetch = client.fetch
export const identityVoiceProtocols = client.voiceProtocols
