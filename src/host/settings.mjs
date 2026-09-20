/** Host-only endpoint settings; trial authentication comes from the package. */
import { readFileSync } from 'node:fs'
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { duetEnv } from './environment.mjs'
import { publicServiceAuthorization } from './service-defaults.mjs'

export function validateBackendURL(value, insecureOrigin = null) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('invalid_backend_url')
  const url = new URL(value)
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('invalid_backend_url')
  // Credentials never belong in URLs or logs.
  if ([...url.searchParams.keys()].some(k => k !== 'protocol')) throw new Error('backend_url_query_not_allowed')
  if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.origin !== insecureOrigin) throw new Error('backend_requires_wss')
  return url.toString()
}

export class DuetSettings {
  constructor(base, { path, debug = false } = {}) {
    this.base = base
    this.path = path || duetEnv('SETTINGS_FILE') || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'duplex-control', 'voice.json')
    this.debug = debug
    this.saved = null
    this.revision = 0
    this.writing = false
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8'))
      this.saved = this.validate(data)
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('invalid_voice_settings_file') }
  }

  validate(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid_voice_settings')
    const backend_url = validateBackendURL(data.backend_url, data.insecure_origin)
    const url = new URL(backend_url)
    const insecure_origin = url.protocol === 'ws:' && url.origin === data.insecure_origin ? url.origin : null
    return { backend_url, ...(insecure_origin ? { insecure_origin } : {}) }
  }

  effective() {
    const endpoints = this.saved ? { online: this.saved.backend_url, tts_only: this.saved.backend_url } : this.base.endpoints
    return { ...this.base, endpoints, authorization: publicServiceAuthorization(endpoints) }
  }

  public() {
    const config = this.effective()
    const endpoints = Object.fromEntries(Object.entries(config.endpoints).map(([mode, value]) => {
      const url = new URL(value)
      url.username = ''; url.password = ''
      for (const key of [...url.searchParams.keys()]) if (key !== 'protocol') url.searchParams.delete(key)
      return [mode, url.toString()]
    }))
    return {
      min_version: config.min_version, max_version_exclusive: config.max_version_exclusive,
      modes: Object.keys(config.endpoints), endpoints,
      backend_url: endpoints.online, config_source: this.saved ? 'plugin_settings' : 'environment_or_default',
      auth_configured: Boolean(config.authorization),
      debug: this.debug, revision: this.revision,
      insecure_transport: new URL(config.endpoints.online).protocol !== 'wss:',
    }
  }

  async save(input) {
    if (this.writing) throw new Error('settings_write_in_progress')
    if (!input || input.revision !== this.revision) throw new Error('settings_revision_conflict')
    // A deliberate, authenticated per-origin opt-in, never a global TLS bypass.
    const insecureOrigin = input.allow_insecure_http === true ? new URL(input.backend_url).origin : this.saved?.insecure_origin
    const url = validateBackendURL(input.backend_url, insecureOrigin)
    const next = this.validate({ backend_url: url, insecure_origin: insecureOrigin })
    this.writing = true
    const temp = `${this.path}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      await writeFile(temp, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' })
      await rename(temp, this.path)
      this.saved = next
      this.revision++
      return this.public()
    } finally { this.writing = false; await unlink(temp).catch(() => {}) }
  }
}

export function settingsWriteAllowed(req) {
  try {
    return req.headers['x-duplex-settings'] === '1'
      && new URL(req.headers.origin).host === req.headers.host
      && String(req.headers['content-type'] || '').startsWith('application/json')
  } catch { return false }
}
