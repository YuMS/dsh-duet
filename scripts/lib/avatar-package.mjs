import {createHash} from 'node:crypto'
import {readFile, readdir, lstat, writeFile, access, chmod} from 'node:fs/promises'
import {join, relative, sep} from 'node:path'
import {AVATAR_UI_PROTOCOL} from '../../src/shared/avatar-surface.mjs'
import {verifyDesktopAssets} from '../../src/host/avatar-assets.mjs'

export const PLATFORMS=['darwin-arm64','win32-x64']
export function helperPath(key) {
  if(!PLATFORMS.includes(key))throw Error(`Unsupported release platform: ${key}`)
  return key.startsWith('darwin-')?'duet-avatar.app/Contents/MacOS/duet-avatar':`duet-avatar${key.startsWith('win32-')?'.exe':''}`
}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
export function binaryPlatform(bytes) {
  if(bytes.length<64)throw Error('Truncated helper')
  if(bytes.toString('ascii',0,2)==='MZ') {
    const pe=bytes.readUInt32LE(60)
    if(pe+6<=bytes.length && bytes.toString('binary',pe,pe+4)==='PE\0\0' && bytes.readUInt16LE(pe+4)===0x8664)return 'win32-x64'
  }
  if(bytes.readUInt32LE(0)===0xfeedfacf) {
    const cpu=bytes.readUInt32LE(4)
    if(cpu===0x100000c)return 'darwin-arm64'
    if(cpu===0x1000007)return 'darwin-x64'
  }
  if(bytes.toString('binary',0,4)==='\x7fELF' && bytes[4]===2 && bytes[5]===1 && bytes.readUInt16LE(18)===62)return 'linux-x64'
  throw Error('Unrecognized helper format or architecture')
}
async function filesIn(dir, base=dir) {
  const result=[]
  for(const item of (await readdir(dir)).sort()) {
    const path=join(dir,item),stat=await lstat(path)
    if(stat.isSymbolicLink())throw Error(`Unexpected symlink: ${path}`)
    if(stat.isDirectory())result.push(...await filesIn(path,base))
    else if(stat.isFile())result.push(relative(base,path).split(sep).join('/'))
  }
  return result.sort()
}
export async function sourceDigest(root) {
  // Native ABI/source identity deliberately excludes replaceable web UI and npm version.
  const paths=['desktop/src-tauri/Cargo.toml','desktop/src-tauri/Cargo.lock','desktop/src-tauri/build.rs','desktop/src-tauri/tauri.conf.json','desktop/src-tauri/tauri.macos.conf.json','desktop/src-tauri/Info.plist']
  for(const dir of ['desktop/bootstrap','desktop/src-tauri/src','desktop/src-tauri/capabilities','desktop/src-tauri/icons'])
    paths.push(...(await filesIn(join(root,dir))).map(p=>`${dir}/${p}`))
  const hash=createHash('sha256').update(`protocol:${AVATAR_UI_PROTOCOL}\n`)
  for(const path of paths.sort()) {
    const bytes=await readFile(join(root,path))
    // Git's text conversion on Windows must not change build identity.
    const content=/\.(m|mjs|js|rs|json|toml|lock|plist|html|css|sh|ps1|yml)$/.test(path)?Buffer.from(bytes.toString('utf8').replaceAll('\r\n','\n')):bytes
    hash.update(path).update('\0').update(sha(content)).update('\n')
  }
  return hash.digest('hex')
}
export async function recordHelper(root,key) {
  const dir=join(root,'desktop/bin',key),file=helperPath(key)
  const bytes=await readFile(join(dir,file))
  if(binaryPlatform(bytes)!==key)throw Error(`Wrong architecture for ${key}`)
  const files={}
  for(const name of await filesIn(dir))if(name!=='manifest.json')files[name]=sha(await readFile(join(dir,name)))
  const version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version
  const manifest={schema:2,protocol:AVATAR_UI_PROTOCOL,platform:key,version,sourceSha256:await sourceDigest(root),executable:file,files}
  await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n')
  return manifest
}
export async function verifyHelpers(root,keys=PLATFORMS,artifactRoot=root) {
  if(!keys.length || new Set(keys).size!==keys.length)throw Error('Select distinct platforms')
  const digest=await sourceDigest(root)
  verifyDesktopAssets(join(artifactRoot,'assets/avatar/desktop'))
  for(const key of keys) {
    const file=helperPath(key),dir=join(artifactRoot,'desktop/bin',key)
    const manifest=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'))
    if(manifest.schema!==2||manifest.protocol!==AVATAR_UI_PROTOCOL||manifest.platform!==key||manifest.sourceSha256!==digest||manifest.executable!==file)throw Error(`Stale or mismatched helper: ${key}`)
    const actual=(await filesIn(dir)).filter(p=>p!=='manifest.json')
    if(JSON.stringify(actual)!==JSON.stringify(Object.keys(manifest.files).sort()))throw Error(`Unexpected bundle files: ${key}`)
    for(const name of actual)if(sha(await readFile(join(dir,name)))!==manifest.files[name])throw Error(`Damaged helper file: ${key}/${name}`)
    if(binaryPlatform(await readFile(join(dir,file)))!==key)throw Error(`Wrong architecture for ${key}`)
    if(key.startsWith('darwin-'))await access(join(dir,'duet-avatar.app/Contents/Info.plist'))
    // ZIP artifact transport may drop modes; restore before npm pack.
    await chmod(join(dir,file),0o755)
  }
  return keys
}
