import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, writeFile, readFile, rm, cp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PLATFORMS, binaryPlatform, helperPath, recordHelper, verifyHelpers} from '../../scripts/lib/avatar-package.mjs'

function binary(key) {
  const b=Buffer.alloc(128)
  if(key==='win32-x64'){b.write('MZ');b.writeUInt32LE(64,60);b.write('PE\0\0',64,'binary');b.writeUInt16LE(0x8664,68)}
  else if(key==='linux-x64'){b.write('\x7fELF',0,'binary');b[4]=2;b[5]=1;b.writeUInt16LE(62,18)}
  else{b.writeUInt32LE(0xfeedfacf);b.writeUInt32LE(key==='darwin-arm64'?0x100000c:0x1000007,4)}
  return b
}
test('release checks actual binary architecture, not directory labels',()=>{
  assert.deepEqual(PLATFORMS,['darwin-arm64','win32-x64'])
  for(const key of ['win32-x64','linux-x64','darwin-arm64','darwin-x64'])assert.equal(binaryPlatform(binary(key)),key)
  assert.throws(()=>binaryPlatform(Buffer.alloc(10)),/Truncated/)
  const wrong=binary('win32-x64');wrong.writeUInt16LE(0xaa64,68)
  assert.throws(()=>binaryPlatform(wrong),/Unrecognized/)
  assert.throws(()=>helperPath('../other'),/Unsupported/)
})
test('packaging rejects mixed sources, modified binaries and extra bundle files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'duet-package-'))
  try {
    const paths=['package.json','package-lock.json','desktop/src-tauri/Cargo.toml','desktop/src-tauri/Cargo.lock','desktop/src-tauri/build.rs','desktop/src-tauri/tauri.conf.json','desktop/src-tauri/tauri.macos.conf.json','desktop/src-tauri/Info.plist','assets/avatar/character.glb','assets/avatar/portrait.png']
    for(const path of paths){await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),path==='package.json'?' {"version":"test"}':'fixture')}
    for(const path of ['src','scripts','desktop/bootstrap','desktop/src-tauri/src','desktop/src-tauri/capabilities','desktop/src-tauri/icons','desktop/bin/win32-x64'])await mkdir(join(root,path),{recursive:true})
    await cp(new URL('../../assets/avatar/desktop/',import.meta.url),join(root,'assets/avatar/desktop'),{recursive:true})
    const exe=join(root,'desktop/bin/win32-x64/duet-avatar.exe')
    await writeFile(exe,binary('win32-x64'))
    await recordHelper(root,'win32-x64')
    assert.deepEqual(await verifyHelpers(root,['win32-x64']),['win32-x64'])
    await assert.rejects(verifyHelpers(root,['darwin-arm64']),/ENOENT/)
    await assert.rejects(verifyHelpers(root,['linux-x64']),/Unsupported/)
    await writeFile(join(root,'src/new.mjs'),'new source')
    assert.deepEqual(await verifyHelpers(root,['win32-x64']),['win32-x64'],'UI-only updates do not require rebuilding the native helper')
    await writeFile(join(root,'desktop/src-tauri/src/native.rs'),'new native source')
    await assert.rejects(verifyHelpers(root,['win32-x64']),/Stale/)
    await rm(join(root,'desktop/src-tauri/src/native.rs'))
    const original=await readFile(exe);const modified=Buffer.from(original);modified[100]=1
    await writeFile(exe,modified)
    await assert.rejects(verifyHelpers(root,['win32-x64']),/Damaged/)
    await writeFile(exe,original)
    await writeFile(join(root,'desktop/bin/win32-x64/extra.dll'),'unexpected')
    await assert.rejects(verifyHelpers(root,['win32-x64']),/Unexpected/)
  }finally{await rm(root,{recursive:true,force:true})}
})
