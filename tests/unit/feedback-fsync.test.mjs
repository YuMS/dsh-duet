import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

// Each child has isolated built-ins/platform state. Model Windows' directory
// flush failure while using real files; this is not a Windows native test.
const script=`
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {syncBuiltinESMExports} from 'node:module';
const {platform,fail,keyPath,moduleURL}=JSON.parse(process.argv[1]);
Object.defineProperty(process,'platform',{value:platform});
const original=fs.fsyncSync;
const calls={file:0,directory:0};
fs.fsyncSync=fd=>{
  const kind=fs.fstatSync(fd).isDirectory()?'directory':'file';
  calls[kind]++;
  if(kind===fail)throw Object.assign(Error('simulated flush failure'),{code:kind==='directory'&&platform==='win32'?'EPERM':'EIO'});
  // Model directory semantics independently of the machine running this test.
  if(kind==='directory')return;
  return original(fd);
};
syncBuiltinESMExports();
const {RemoteFeedback}=await import(moduleURL);
const store=new RemoteFeedback(()=>({}),{keyPath});
let cookie;
const create=()=>store.ensureCredential({headers:{}},{setHeader:(_name,value)=>{cookie=value}});
if(fail==='file'||(fail==='directory'&&platform!=='win32')){
  assert.throws(create,{code:'EIO'});
  assert.equal(cookie,undefined);
  if(fail==='file')assert.equal(fs.existsSync(keyPath),false);
}else{
  const token=create();
  assert.ok(cookie);
  assert.equal(fs.readFileSync(keyPath).length,32);
  const id=store.userId({headers:{'x-duet-identity':token}});
  const restarted=new RemoteFeedback(()=>({}),{keyPath});
  assert.equal(restarted.userId({headers:{'x-duet-identity':token}}),id);
  assert.equal(restarted.ensureCredential({headers:{'x-duet-identity':token}},{setHeader(){assert.fail('must reuse identity')}}),token);
}
console.log(JSON.stringify(calls));
`;
for(const [name,platform,fail,expected] of [
  ['Windows first identity succeeds despite unsupported directory fsync','win32','directory',{file:1,directory:0}],
  ['POSIX still flushes the file and its directory','linux','none',{file:1,directory:1}],
  ['Windows file fsync failures remain fatal','win32','file',{file:1,directory:0}],
  ['POSIX directory fsync errors are not silently ignored','linux','directory',{file:1,directory:1}],
])test(name,()=>{
  const dir=mkdtempSync(join(tmpdir(),'duet-fsync-'));
  try{
    const result=spawnSync(process.execPath,['--input-type=module','-e',script,JSON.stringify({platform,fail,keyPath:join(dir,'identity.key'),moduleURL:new URL('../../src/host/feedback-files.mjs',import.meta.url).href})],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr||result.error?.message);
    assert.deepEqual(JSON.parse(result.stdout),expected);
  }finally{rmSync(dir,{recursive:true,force:true})}
});
