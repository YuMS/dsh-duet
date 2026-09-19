import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import { PLUGIN_VERSION } from '../deepseek_harness_voice_state.mjs'
const root = new URL('../', import.meta.url)
const read = name => readFileSync(new URL(name, root), 'utf8')
const pkg = JSON.parse(read('package.json'))
assert.equal(pkg.name, 'dsh-duet')
assert.equal(pkg.version, PLUGIN_VERSION)
assert.equal(pkg.dsh.client.platform, 'web')
for (const item of [pkg.main, pkg.exports['./client'].default, pkg.dsh.bundle.patch]) {
  assert.ok(existsSync(new URL(item, root)), `missing entry ${item}`)
}
assert.match(read(pkg.dsh.bundle.patch), /name: ['"]?dsh-duet['"]?/)
let client
vm.runInNewContext(read(pkg.exports['./client'].default), {
  window: { __ModuleLoader__: { load: definition => { client = definition } } },
})
assert.equal(client.id, pkg.name)
assert.equal(typeof client.factory, 'function')
for (const name of [...readdirSync(root).filter(f => /^deepseek_harness.*\.(mjs|html)$/.test(f)), pkg.exports['./client'].default]) {
  const source = read(name)
  assert.ok(!/@[a-z0-9_.-]+\/dsh-duplex-control/.test(source), `unexpected package identity: ${name}`)
  assert.ok(!source.includes('/cpfs/'), `deployment path: ${name}`)
  for (const match of source.matchAll(/\?v=(\d+\.\d+\.\d+)/g)) assert.equal(match[1], pkg.version, name)
}
const manifest = JSON.parse(read('tutorial-audio/manifest.json'))
for (const [name, clip] of Object.entries(manifest.clips)) {
  const data = readFileSync(new URL(`tutorial-audio/${name}.wav`, root))
  assert.equal(createHash('sha256').update(data).digest('hex'), clip.sha256, name)
}
console.log(`Package ${pkg.name}@${pkg.version}: entries, browser identity, versions and ${Object.keys(manifest.clips).length} audio hashes passed`)
