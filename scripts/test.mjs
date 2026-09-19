import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = new URL('../', import.meta.url)
const home = mkdtempSync(join(tmpdir(), 'dsh-duet-test-'))
try {
  const files = readdirSync(root).filter(f => /^test_.*\.mjs$/.test(f)).sort()
  const result = spawnSync(process.execPath, ['--test', ...files], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, DSH_HOME: home, DUPLEX_VOICE_TRACE_DIR: join(home, 'traces') },
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally { rmSync(home, { recursive: true, force: true }) }
