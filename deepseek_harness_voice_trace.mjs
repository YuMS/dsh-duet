/** Private, append-only connection capture. Never served as a web asset. */
import { createWriteStream, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export function redact(value, secrets = []) {
  if (typeof value === 'string') {
    for (const secret of secrets) if (secret) value = value.split(secret).join('[REDACTED]')
    return value.replace(/([?&](?:token|api_key|access_token|authorization)=)[^&#\s]*/gi, '$1[REDACTED]')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
  }
  if (Array.isArray(value)) return value.map(v => redact(v, secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, /^(?:authorization|auth_token|api_key|access_token|token|cookie|set-cookie|password|secret)$/i.test(k) ? '[REDACTED]' : redact(v, secrets)]))
  return value
}

const budgets = new Map()
export class VoiceTrace {
  constructor(metadata, { root = process.env.DUPLEX_VOICE_TRACE_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'duplex-control', 'traces'),
    secrets = [], maxBytes = 512 * 1024 ** 2, totalBytes = 20 * 1024 ** 3, queueBytes = 8 * 1024 ** 2 } = {}) {
    this.id = randomUUID(); this.start = performance.now(); this.seq = 0; this.bytes = 0
    this.offset = 0; this.closed = false; this.error = null; this.secrets = secrets
    this.maxBytes = maxBytes; this.queueBytes = queueBytes
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 })
      // Once per process/root; reserve bytes at enqueue time across concurrent sessions.
      if (!budgets.has(root)) {
        let used = 0
        const folders = []
        for (const dir of readdirSync(root, { withFileTypes: true })) {
          if (!dir.isDirectory()) continue
          if (/^\d{4}-\d{2}-\d{2}$/.test(dir.name)) {
            for (const child of readdirSync(join(root, dir.name), { withFileTypes: true })) {
              if (child.isDirectory()) folders.push(join(root, dir.name, child.name))
            }
          } else if (/^\d{4}-.*_[a-f0-9-]{36}$/.test(dir.name)) folders.push(join(root, dir.name))
        }
        for (const folder of folders) {
          for (const name of ['events.jsonl', 'audio.bin']) {
            try { used += statSync(join(folder, name)).size } catch { /* missing partial file */ }
          }
        }
        budgets.set(root, { used })
      }
      this.budget = budgets.get(root); this.totalBytes = totalBytes
      const date = new Date().toISOString()
      const day = join(root, date.slice(0, 10))
      mkdirSync(day, { recursive: true, mode: 0o700 })
      this.path = join(day, date.replaceAll(':', '-') + '_' + this.id)
      mkdirSync(this.path, { mode: 0o700 })
      this.events = createWriteStream(join(this.path, 'events.jsonl'), { flags: 'wx', mode: 0o600 })
      this.audio = createWriteStream(join(this.path, 'audio.bin'), { flags: 'wx', mode: 0o600 })
      for (const stream of [this.events, this.audio]) stream.on('error', error => this.disable(error.code || 'write_failed'))
      this.event('trace.started', { schema: 'duplex_voice_trace_v1', ...metadata,
        input_format: 'pcm_s16le/16000/mono', limits: { maxBytes, totalBytes, queueBytes } })
    } catch (error) { this.disable(error.code || 'open_failed') }
  }

  disable(reason) {
    if (this.error) return
    this.error = reason
    // No payloads or credentials in stderr, and never crash audio for a logging error.
    console.error(`[duplex-trace] capture incomplete trace=${this.id} reason=${reason}`)
    if (this.events && !this.events.destroyed) {
      this.events.end(JSON.stringify({ type: 'trace.incomplete', reason, utc: new Date().toISOString() }) + '\n')
    }
    this.audio?.end()
  }

  event(type, data, binary) {
    if (this.closed || this.error) return
    const record = { seq: this.seq++, utc: new Date().toISOString(), elapsed_ms: performance.now() - this.start,
      type, data: redact(data, this.secrets) }
    if (binary) record.blob = { file: 'audio.bin', offset: this.offset, bytes: binary.length }
    const line = JSON.stringify(record) + '\n'
    const size = Buffer.byteLength(line) + (binary?.length || 0)
    if (this.bytes + size > this.maxBytes || this.budget.used + size > this.totalBytes) { this.disable('quota_exceeded'); return }
    if (this.events.writableLength + this.audio.writableLength + size > this.queueBytes) { this.disable('disk_backpressure'); return }
    this.bytes += size; this.budget.used += size
    if (binary) { this.audio.write(binary); this.offset += binary.length }
    this.events.write(line)
  }

  frame(direction, raw, binary = false) {
    if (binary) { this.event(direction, { wire: 'binary' }, Buffer.from(raw)); return }
    try {
      const message = JSON.parse(raw.toString())
      if (/audio/.test(message.type || '') && typeof message.delta === 'string') {
        const data = { ...message, delta: { stored_as: 'blob', encoding: 'base64' } }
        this.event(direction, data, Buffer.from(message.delta, 'base64'))
      } else this.event(direction, message)
    } catch { this.event(direction, { invalid_json: String(raw) }) }
  }

  snapshot() { return { trace_id: this.id, bytes: this.bytes, complete: !this.error, error: this.error } }

  async close(data = {}) {
    if (this.closed) return
    this.event('trace.closed', data); this.closed = true
    await Promise.all([this.events, this.audio].filter(Boolean).map(stream => new Promise(resolve => {
      if (stream.closed || stream.destroyed) { resolve(); return }
      stream.once('close', resolve); stream.end()
    })))
  }
}
