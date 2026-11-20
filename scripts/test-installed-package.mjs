/** Install only the supplied release archive in an unrelated, empty directory. */
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve,relative,isAbsolute,sep} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'

if(process.argv.length!==3)throw Error('Usage: node scripts/test-installed-package.mjs /path/to/dsh-duet.tgz')
const archive=resolve(process.argv[2]),home=await mkdtemp(join(tmpdir(),'duet-package-install-'))
const inside=path=>{const p=relative(home,path);return p!== '..'&&!p.startsWith('..'+sep)&&!isAbsolute(p)}
try{
  const npm=process.platform==='win32'?'npm.cmd':'npm'
  const r=spawnSync(npm,['install','--prefix',home,archive,'--ignore-scripts','--no-audit','--no-fund'],
    {cwd:home,env:{...process.env,NODE_PATH:'',DSH_HOME:join(home,'home')},stdio:'inherit',timeout:120000,
      shell:process.platform==='win32'})
  assert.equal(r.status,0,'Clean package installation failed')
  const plugin=join(home,'node_modules/dsh-duet'),require=createRequire(join(plugin,'package.json'))
  const agent=require.resolve('dsh-duet-superagent/duet')
  assert.ok(inside(agent), 'Agent resolved outside installed package')
  const agentRequire=createRequire(agent)
  for(const name of ['proper-lockfile','zod'])assert.ok(inside(agentRequire.resolve(name)))
  const host=await import(pathToFileURL(join(plugin,'src/host/plugin.mjs')))
  assert.equal(host.name,'dsh-duet')
  const p=JSON.parse(await readFile(join(plugin,'package.json'),'utf8'))
  const {compatibleVersion,duetConfig}=await import(pathToFileURL(join(plugin,'src/host/proxy.mjs')))
  const c=duetConfig({});assert.ok(compatibleVersion(p.version,c.min_version,c.max_version_exclusive))
  console.log(`Clean installation passed: dsh-duet@${p.version}, bundled agent and runtime dependencies`)
}finally{await rm(home,{recursive:true,force:true})}
