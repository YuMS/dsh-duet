// Run on Windows x64 after `npm ci`. Produces one return archive, never publishes.
import {spawnSync} from 'node:child_process'
import {openSync,closeSync} from 'node:fs'
import {mkdir,mkdtemp,readFile,writeFile,cp} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'

if(process.platform!=='win32'||process.arch!=='x64')throw Error('Run this script using x64 Node.js on Windows x64.')
if(Number(process.versions.node.split('.')[0])<24)throw Error('Install Node.js 24 LTS (x64) first.')
const root=fileURLToPath(new URL('../',import.meta.url))
const artifacts=join(root,'artifacts')
await mkdir(artifacts,{recursive:true})
const stage=await mkdtemp(join(artifacts,'windows-build-'))
await mkdir(join(stage,'logs'))
const report={platform:process.platform,arch:process.arch,node:process.version,startedAt:new Date().toISOString(),stages:[],success:false}
async function saveReport(){await writeFile(join(stage,'build-report.json'),JSON.stringify(report,null,2)+'\n')}
function run(label,command,args) {
  console.log(`\n${label}... (log: ${join(stage,'logs',label+'.log')})`)
  const fd=openSync(join(stage,'logs',label+'.log'),'w'),start=Date.now()
  let result
  try{result=spawnSync(command,args,{cwd:root,stdio:['ignore',fd,fd],windowsHide:true})}
  finally{closeSync(fd)}
  report.stages.push({label,exitCode:result.status,error:result.error?.message,seconds:Math.round((Date.now()-start)/1000)})
  if(result.error||result.status!==0)throw Error(`${label} failed. See its log. ${result.error?.message||''}`)
  console.log(`${label}: passed`)
}
try {
  run('preflight',process.execPath,['scripts/build-avatar-desktop.mjs','--check'])
  run('build',process.execPath,['scripts/build-avatar-desktop.mjs'])
  run('rust-tests','cargo',['test','--locked','--manifest-path','desktop/src-tauri/Cargo.toml'])
  run('unit-tests',process.execPath,['scripts/test.mjs'])
  run('package-check',process.execPath,['scripts/check-package.mjs'])
  run('verify-helper',process.execPath,['scripts/verify-avatar-package.mjs','--platforms','win32-x64'])
  run('native-smoke',process.execPath,['scripts/test-avatar-native.mjs'])
  const manifest=JSON.parse(await readFile(join(root,'desktop/bin/win32-x64/manifest.json'),'utf8'))
  report.sourceSha256=manifest.sourceSha256
  report.pluginVersion=manifest.version
  report.visualInteractionVerified=false
  await cp(join(root,'desktop/bin/win32-x64'),join(stage,'win32-x64'),{recursive:true})
  report.success=true
  await saveReport()
  const filename=`duet-avatar-win32-x64-${manifest.version}-${manifest.sourceSha256.slice(0,12)}.tgz`
  const output=join(artifacts,filename)
  // Keep the pack log outside the archive to avoid archiving a file while writing it.
  const result=spawnSync('tar',['-czf',output,'-C',stage,'win32-x64','build-report.json','logs'],{cwd:root,stdio:'inherit',windowsHide:true})
  if(result.error||result.status!==0)throw Error('Could not create return archive; zip the windows-build directory instead.')
  const checksum=createHash('sha256').update(await readFile(output)).digest('hex')
  await writeFile(output+'.sha256',`${checksum}  ${filename}\n`)
  console.log(`\nSend back these two files:\n${output}\n${output}.sha256`)
}catch(error) {
  report.success=false;report.error=error.message
  await saveReport()
  console.error(`\n${error.message}\nIf building failed, send this folder (ZIP it first):\n${stage}`)
  process.exitCode=1
}
