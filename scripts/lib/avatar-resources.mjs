import {createHash} from 'node:crypto'
import {readFile,writeFile,mkdir,mkdtemp,rename,rm,lstat} from 'node:fs/promises'
import {join,resolve} from 'node:path'

export const RESOURCE_FILES=Object.freeze(['character.glb','portrait.png'])
const maxBytes=64*1024*1024
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
export function validateResourceLock(value) {
  if(value?.schema!==1||!/^duet-avatar-v[1-9][0-9]*(?:\.[0-9]+)*$/.test(value.version)||value.rig!=='duet-rig-v1')throw Error('Unsupported avatar resource lock')
  if(JSON.stringify(Object.keys(value.files||{}).sort())!==JSON.stringify([...RESOURCE_FILES].sort()))throw Error('Unexpected avatar resource files')
  for(const name of RESOURCE_FILES){
    const entry=value.files[name],url=new URL(entry.url)
    if(url.protocol!=='https:'||url.username||url.password||url.hash||!Number.isSafeInteger(entry.bytes)||entry.bytes<8||entry.bytes>maxBytes||!(/^[a-f0-9]{64}$/).test(entry.sha256))throw Error(`Invalid resource entry: ${name}`)
  }
  return value
}
export async function resourceLock(root) {return validateResourceLock(JSON.parse(await readFile(join(root,'avatar-assets.lock.json'),'utf8')))}
export function validateResource(name,bytes,lock) {
  const entry=lock.files[name]
  if(!entry||bytes.length!==entry.bytes||sha(bytes)!==entry.sha256)throw Error(`Resource checksum or size mismatch: ${name}`)
  if(name==='portrait.png'){
    if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('Invalid portrait PNG')
  }else if(name==='character.glb'){
    if(bytes.length<20||bytes.toString('ascii',0,4)!=='glTF'||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length||bytes.readUInt32LE(16)!==0x4e4f534a)throw Error('Invalid avatar GLB')
    const length=bytes.readUInt32LE(12)
    if(length>bytes.length-20)throw Error('Truncated avatar GLB')
    const gltf=JSON.parse(bytes.subarray(20,20+length).toString('utf8'))
    const names=new Set((gltf.nodes||[]).map(n=>n.name))
    if(gltf.asset?.version!=='2.0'||!['V1_NeckHead','RIG | 颈部转动支点'].every(n=>names.has(n))||!['Mouth |','Eye |'].every(prefix=>[...names].some(n=>typeof n==='string'&&n.startsWith(prefix))))throw Error('Avatar rig does not match duet-rig-v1')
    if([...(gltf.buffers||[]),...(gltf.images||[])].some(v=>v.uri&&!v.uri.startsWith('data:')))throw Error('Avatar must not reference external resources')
  }
}
async function regularFile(path) {
  const stat=await lstat(path)
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maxBytes)throw Error(`Not a bounded regular resource: ${path}`)
  return readFile(path)
}
export function resourceDirectory(root,lock) {return join(resolve(root),'.cache','avatar-assets',lock.version)}
export async function verifyResources(root) {
  const lock=await resourceLock(root),directory=resourceDirectory(root,lock)
  const stat=await lstat(directory)
  if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Invalid avatar cache directory')
  for(const name of RESOURCE_FILES)validateResource(name,await regularFile(join(directory,name)),lock)
  return {lock,directory}
}
async function download(entry,fetchImpl) {
  const response=await fetchImpl(entry.url,{signal:AbortSignal.timeout(120000),redirect:'follow'})
  if(!response.ok)throw Error(`Avatar resource download failed: HTTP ${response.status}. Publish the pinned release first, or import verified local exports with --from.`)
  if(response.url&&new URL(response.url).protocol!=='https:')throw Error('Avatar download redirected away from HTTPS')
  const length=response.headers.get('content-length')
  if(length!==null&&Number(length)!==entry.bytes){await response.body?.cancel();throw Error('Avatar download size mismatch')}
  if(!response.body)throw Error('Empty avatar download')
  const reader=response.body.getReader(),chunks=[];let total=0
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>entry.bytes)throw Error('Avatar download exceeds pinned size');chunks.push(value)}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
  return Buffer.concat(chunks,total)
}
/** Explicit acquisition only. Never called automatically by install or runtime. */
export async function prepareResources(root,{from,fetchImpl=globalThis.fetch}={}) {
  const lock=await resourceLock(root),directory=resourceDirectory(root,lock)
  if(!from){try{return await verifyResources(root)}catch(error){if(error.code!=='ENOENT')throw error}}
  const data=new Map()
  for(const name of RESOURCE_FILES){const bytes=from?await regularFile(join(resolve(from),name)):await download(lock.files[name],fetchImpl);validateResource(name,bytes,lock);data.set(name,bytes)}
  // Validate every input before writing anything. Existing validated versions
  // are immutable: changed exports require a new lock/version, not overwrite.
  try{return await verifyResources(root)}catch(error){if(error.code!=='ENOENT')throw error}
  const parent=join(resolve(root),'.cache','avatar-assets');await mkdir(parent,{recursive:true})
  const temporary=await mkdtemp(join(parent,'.incoming-'))
  try{
    for(const [name,bytes]of data)await writeFile(join(temporary,name),bytes,{flag:'wx'})
    await writeFile(join(temporary,'resource-lock.json'),JSON.stringify(lock,null,2)+'\n',{flag:'wx'})
    try{await rename(temporary,directory)}catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;await verifyResources(root)}
  }finally{await rm(temporary,{recursive:true,force:true})}
  return verifyResources(root)
}
