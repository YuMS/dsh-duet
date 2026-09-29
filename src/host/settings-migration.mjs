/** Retired addresses are migration inputs only, never connection/auth targets. */
import { writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { DEFAULT_DUET_URL } from './service-defaults.mjs'

export function migrateRetiredSettings(data, path) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  let url
  try { url = new URL(data.backend_url) } catch { return data }
  const retired = [
    'duet-router.1781574661016173.ap-southeast-1.pai-eas.aliyuncs.com',
    'duet-router-acc.gw-bmmaj5gve68z3gw34o.ap-southeast-1.pai-eas.aliyuncs.com',
  ]
  if (!retired.includes(url.hostname) || !['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol)
    || url.port || url.username || url.password || url.hash || !['/', '/ws'].includes(url.pathname)
    || [...url.searchParams].some(([k,v]) => k !== 'protocol' || v !== 'realtime_v2')) return data
  const next = { backend_url: DEFAULT_DUET_URL }
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(temp, path)
  } catch { /* Read-only storage must not prevent using the current default. */ }
  finally { try { unlinkSync(temp) } catch {} }
  return next
}
