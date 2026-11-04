import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,readdir,rm,mkdir,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {validateResourceLock,validateResource,prepareResources,verifyResources,resourceDirectory} from '../../scripts/lib/avatar-resources.mjs'

function glb(nodes=['V1_NeckHead','RIG | 颈部转动支点','Mouth | open','Eye | left'],extra={}) {
  let json=Buffer.from(JSON.stringify({asset:{version:'2.0'},nodes:nodes.map(name=>({name})),...extra}))
  json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)])
  const header=Buffer.alloc(20);header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(20+json.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16)
  return Buffer.concat([header,json])
}
const hash=b=>createHash('sha256').update(b).digest('hex')
async function fixture(fn){
  const root=await mkdtemp(join(tmpdir(),'duet-resources-')),from=join(root,'exports');await mkdir(from)
  const data={'character.glb':glb(),'portrait.png':Buffer.from([137,80,78,71,13,10,26,10,0,0])}
  const lock={schema:1,version:'duet-avatar-v1',rig:'duet-rig-v1',files:Object.fromEntries(Object.entries(data).map(([name,b])=>[name,{url:'https://example.invalid/'+name,bytes:b.length,sha256:hash(b)}]))}
  await writeFile(join(root,'avatar-assets.lock.json'),JSON.stringify(lock))
  for(const [name,b]of Object.entries(data))await writeFile(join(from,name),b)
  try{await fn({root,from,data,lock})}finally{await rm(root,{recursive:true,force:true})}
}
test('local import copies only the selected resource files',()=>fixture(async({root,from,lock})=>{
  await writeFile(join(from,'extra.dat'),'extra fixture')
  const result=await prepareResources(root,{from,fetchImpl:()=>assert.fail('local import must not download')})
  assert.equal(result.lock.version,lock.version)
  assert.deepEqual((await readdir(result.directory)).sort(),['character.glb','portrait.png','resource-lock.json'])
  await verifyResources(root)
  await prepareResources(root,{fetchImpl:()=>assert.fail('valid cache must not download')})
}))
test('download checks HTTPS, byte lengths and hashes before promoting cache',()=>fixture(async({root,data})=>{
  let count=0
  await prepareResources(root,{fetchImpl:async url=>{count++;return new Response(data[new URL(url).pathname.slice(1)])}})
  assert.equal(count,2);await verifyResources(root)
}))
test('failed or truncated download leaves no partial installed resource version',()=>fixture(async({root,data,lock})=>{
  await assert.rejects(prepareResources(root,{fetchImpl:async url=>url.endsWith('.png')?new Response('missing',{status:404}):new Response(data['character.glb'])}),/HTTP 404/)
  await assert.rejects(readFile(join(resourceDirectory(root,lock),'character.glb')),/ENOENT/)
  await assert.rejects(prepareResources(root,{fetchImpl:async()=>new Response(Buffer.from('short'))}),/checksum or size/)
}))
test('oversized streams and misleading Content-Length are rejected',()=>fixture(async({root,data})=>{
  await assert.rejects(prepareResources(root,{fetchImpl:async()=>new Response(Buffer.concat([data['character.glb'],Buffer.from('extra')]))}),/exceeds pinned size/)
  await assert.rejects(prepareResources(root,{fetchImpl:async()=>new Response(data['character.glb'],{headers:{'Content-Length':'999'}})}),/size mismatch/)
}))
test('resource locks reject traversal, extra files, credential URLs and oversized entries',()=>fixture(async({lock})=>{
  const bad=change=>{const v=structuredClone(lock);change(v);assert.throws(()=>validateResourceLock(v))}
  bad(v=>v.version='../outside');bad(v=>v.files['extra.dat']=v.files['portrait.png'])
  bad(v=>v.files['portrait.png'].url='https://user:password@example.invalid/file')
  bad(v=>v.files['portrait.png'].url='http://example.invalid/file')
  bad(v=>v.files['portrait.png'].bytes=100_000_000);bad(v=>v.files['portrait.png'].sha256='wrong')
}))
test('GLB interface and embedded-only dependencies are independently validated',()=>fixture(async({lock})=>{
  const check=(bytes,pattern)=>{const v=structuredClone(lock);v.files['character.glb']={...v.files['character.glb'],bytes:bytes.length,sha256:hash(bytes)};assert.throws(()=>validateResource('character.glb',bytes,v),pattern)}
  check(glb(['other']),/rig/);check(glb(undefined,{images:[{uri:'https://external.invalid/texture.png'}]}),/external resources/)
  check(Buffer.alloc(30),/Invalid avatar GLB/)
}))
test('explicit local import cannot silently use cache when input differs',()=>fixture(async({root,from,data})=>{
  const {directory}=await prepareResources(root,{from})
  await writeFile(join(from,'portrait.png'),'corrupt')
  await assert.rejects(prepareResources(root,{from}),/checksum or size/)
  assert.deepEqual(await readFile(join(directory,'portrait.png')),data['portrait.png'])
}))
test('corrupt cache is not silently replaced or accepted',()=>fixture(async({root,from})=>{
  const {directory}=await prepareResources(root,{from})
  await writeFile(join(directory,'portrait.png'),'corrupt')
  await assert.rejects(prepareResources(root,{fetchImpl:()=>assert.fail('corrupt cache must stop before network')}),/checksum or size/)
}))
test('symlink exports are rejected',async t=>fixture(async({root,from,data})=>{
  await writeFile(join(root,'outside.png'),data['portrait.png']);await rm(join(from,'portrait.png'))
  try{await symlink(join(root,'outside.png'),join(from,'portrait.png'))}catch(e){if(e.code==='EPERM'){t.skip('symlink permission unavailable');return}throw e}
  await assert.rejects(prepareResources(root,{from}),/regular resource/)
}))
test('concurrent imports converge on one complete pinned version',()=>fixture(async({root,from})=>{
  const result=await Promise.all([prepareResources(root,{from}),prepareResources(root,{from})])
  assert.equal(result[0].directory,result[1].directory);await verifyResources(root)
  assert.deepEqual(await readdir(join(root,'.cache','avatar-assets')),['duet-avatar-v1'])
}))
