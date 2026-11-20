import assert from 'node:assert/strict'
import {readFile, readdir, lstat} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {join, resolve, sep} from 'node:path'

const source=fileURLToPath(new URL('../',import.meta.url))
const args=process.argv.slice(2)
if(args.length && (args.length!==2 || args[0]!=='--package-root'))throw Error('Usage: verify-agent-package.mjs [--package-root directory]')
const root=args.length?resolve(args[1]):source
const agent=join(root,'node_modules/dsh-duet-superagent')
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
assert.ok(pkg.bundleDependencies?.includes('dsh-duet-superagent'),'Super Agent must be bundled')
assert.ok(!(await lstat(agent)).isSymbolicLink(),'Install the built module with npm ci --install-links before packing')
const dependency=JSON.parse(await readFile(join(agent,'package.json'),'utf8'))
assert.equal(dependency.name,'dsh-duet-superagent')
assert.equal(dependency.exports['./duet'].default,'./lib/duet.js')
const sha=b=>createHash('sha256').update(b).digest('hex')
let count=0
async function verifyDirectory(path) {
  for(const entry of await readdir(join(source,'vendor/dsh-duet-superagent',path),{withFileTypes:true})) {
    const name=join(path,entry.name)
    if(entry.isDirectory())await verifyDirectory(name)
    else if(entry.isFile()) {
      const expected=await readFile(join(source,'vendor/dsh-duet-superagent',name))
      assert.equal(sha(await readFile(join(agent,name))),sha(expected),`Stale/missing agent resource: ${name}`)
      count++
    } else throw Error(`Unexpected agent resource: ${name}`)
  }
}
for(const dir of ['lib','prompts','skills','locale'])await verifyDirectory(dir)
await readFile(join(agent,'LICENSE'))
const require=createRequire(join(agent,'package.json'))
for(const name of Object.keys(dependency.dependencies||{})) {
  const resolved=require.resolve(name)
  assert.ok(resolved.startsWith(join(root,'node_modules')+sep),`Dependency outside package: ${name}`)
}
console.log(`Bundled Super Agent: ${dependency.version}, ${count} compiled/resource files verified`)
