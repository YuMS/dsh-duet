/** Anonymous identity transport, independent of DSH authentication. */
export const IDENTITY_HEADER = 'X-Duet-Identity'
export const IDENTITY_TRANSPORT_HEADER = 'X-Duet-Identity-Transport'
export const IDENTITY_TRANSPORT = 'local-v1'
export const IDENTITY_STORAGE = 'dsh-duet.feedback-identity.v1'
export const VOICE_PROTOCOL = 'duet-voice-v1'
export const IDENTITY_PROTOCOL_PREFIX = 'duet-identity.'
export const validIdentityToken = value => typeof value === 'string' && /^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(value)
