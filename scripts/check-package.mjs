import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import { PLUGIN_VERSION } from '../src/shared/state.mjs'
import { publicAsset } from '../src/host/assets.mjs'
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
assert.ok(!readdirSync(root).some(f => /^(?:deepseek_harness|test_|smoke_)/.test(f) && /\.(?:mjs|js|html|yml)$/.test(f)), 'runtime and tests belong in their own directories')
for (const name of readdirSync(new URL('src/', root), {recursive:true}).filter(f => /\.(mjs|js|html)$/.test(f)).map(f => `src/${f}`)) {
  const source = read(name)
  assert.ok(!/@[a-z0-9_.-]+\/dsh-duplex-control/.test(source), `unexpected package identity: ${name}`)
  assert.ok(!source.includes('/cpfs/'), `deployment path: ${name}`)
  for (const match of source.matchAll(/\?v=(\d+\.\d+\.\d+)/g)) assert.equal(match[1], pkg.version, name)
  for (const match of source.matchAll(/(?:from\s*|import\s*\()(['"])(\.[^'"\n]+)\1/g)) {
    const target = new URL(match[2], new URL(name, root))
    assert.ok(existsSync(target), `missing import ${name}: ${match[2]}`)
    if (name.startsWith('src/client/') || name.startsWith('src/shared/')) {
      const relative = target.pathname.slice(new URL('src/', root).pathname.length)
      assert.ok(publicAsset(`/duet/assets/${relative}`), `unserved client dependency: ${name}: ${match[2]}`)
    }
  }
}
const manifest = JSON.parse(read('assets/tutorial-audio/manifest.json'))
for (const [name, clip] of Object.entries(manifest.clips)) {
  const data = readFileSync(new URL(`assets/tutorial-audio/${name}.wav`, root))
  assert.equal(createHash('sha256').update(data).digest('hex'), clip.sha256, name)
}
console.log(`Package ${pkg.name}@${pkg.version}: entries, browser identity, versions and ${Object.keys(manifest.clips).length} audio hashes passed`)
