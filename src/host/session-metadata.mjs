/** Shared, connection-scoped diagnostics for both voice modes. No account identity. */
import {randomUUID} from 'node:crypto'
import {PLUGIN_VERSION} from '../shared/state.mjs'

function identifier(value){
  return typeof value==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(value)?value:''
}
export function sessionMetadata(params,mode,anonymousUserId){
  if(!['online','tts_only'].includes(mode))throw Error('invalid_voice_mode')
  return Object.freeze({name:'dsh-duet',version:(params.get('plugin_version')||'').slice(0,64),
    protocol_major:1,metadata_version:'duet_session_v1',mode,
    host_version:PLUGIN_VERSION,page_binding:'connection_owner_v1',
    client_trace_id:identifier(params.get('client_trace_id'))||randomUUID(),
    page_id:identifier(params.get('page_id')),
    ...(typeof anonymousUserId==='string'&&/^anon_[a-f0-9]{32}$/.test(anonymousUserId)
      ?{anonymous_user_id:anonymousUserId,identity_kind:'anonymous_browser'}:{})})
}
