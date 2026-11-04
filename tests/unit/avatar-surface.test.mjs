import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,cp,writeFile,rm,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {avatarSurface,avatarSurfaceAction} from '../../src/shared/avatar-surface.mjs'
import {verifyDesktopAssets,desktopAssetsPath} from '../../src/host/avatar-assets.mjs'
test('surface IPC has bounded presentation-only fields',()=>{
 const input={type:'surface',secret:'no',panel:{id:'s1',revision:1,ticket:'no',nodes:[{kind:'button',text:'确认发送',action:'a1',onClick:'no',url:'https://invalid'}]}}
 const output=avatarSurface(input)
 assert.equal(output.secret,undefined);assert.equal(output.panel.ticket,undefined);assert.equal(output.panel.nodes[0].onClick,undefined)
 assert.equal(output.panel.nodes[0].text,'确认发送')
 assert.deepEqual(avatarSurface({type:'surface',panel:null}),{type:'surface',panel:null})
 for(const nodes of [[{kind:'html',text:'<script>'}],Array(161).fill({kind:'text',text:'x'}),Array(4).fill({kind:'text',text:'x'.repeat(4000)})])assert.throws(()=>avatarSurface({...input,panel:{...input.panel,nodes}}))
 assert.throws(()=>avatarSurfaceAction({type:'surface_action',id:'../',revision:1,action:'a1'}))
 assert.deepEqual(avatarSurfaceAction({type:'surface_action',id:'s1',revision:1,action:'a1',ticket:'secret'}),{type:'surface_action',id:'s1',revision:1,action:'a1',checked:false})
})
test('external desktop assets reject damage, incompatible protocol and path escapes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'duet-assets-'))
 try{
  await cp(desktopAssetsPath,join(dir,'ui'),{recursive:true})
  assert.equal(verifyDesktopAssets(join(dir,'ui')),join(dir,'ui'))
  await writeFile(join(dir,'ui/companion.mjs'),'damaged')
  assert.throws(()=>verifyDesktopAssets(join(dir,'ui')),/damaged/)
  await cp(desktopAssetsPath,join(dir,'ui'),{recursive:true})
  await rm(join(dir,'ui/index.html'));await writeFile(join(dir,'outside'),'unsafe')
  await symlink(join(dir,'outside'),join(dir,'ui/index.html'))
  assert.throws(()=>verifyDesktopAssets(join(dir,'ui')),/invalid/)
  await writeFile(join(dir,'ui/manifest.json'),'{"protocol":1,"files":{}}')
  assert.throws(()=>verifyDesktopAssets(join(dir,'ui')),/incompatible/)
 }finally{await rm(dir,{recursive:true,force:true})}
})
