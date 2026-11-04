import { build } from 'esbuild'
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {AVATAR_UI_PROTOCOL} from '../src/shared/avatar-surface.mjs'
import {DESKTOP_ASSET_FILES} from '../src/host/avatar-assets.mjs'
import { fileURLToPath } from 'node:url'
import {join} from 'node:path'
import {verifyResources, RESOURCE_FILES} from './lib/avatar-resources.mjs'
const root = new URL('../', import.meta.url)
const resources = await verifyResources(fileURLToPath(root)).catch(error => {
  if (error.code === 'ENOENT') throw Error('Avatar resources are missing. Run node scripts/prepare-avatar-assets.mjs first.', {cause:error})
  throw error
})
await mkdir(new URL('assets/avatar/', root), {recursive:true})
await build({entryPoints:[fileURLToPath(new URL('src/avatar/renderer.mjs',root))],bundle:true,format:'esm',minify:true,
  outfile:fileURLToPath(new URL('assets/avatar/renderer.mjs',root)),legalComments:'eof'})
for (const file of RESOURCE_FILES) await copyFile(join(resources.directory,file),new URL(`assets/avatar/${file}`,root))
await copyFile(new URL('node_modules/three/LICENSE',root),new URL('assets/avatar/THREE-LICENSE.txt',root))
await mkdir(new URL('desktop/frontend/',root),{recursive:true})
await build({entryPoints:[fileURLToPath(new URL('src/avatar/companion.mjs',root))],bundle:true,format:'esm',minify:true,
  external:['./renderer.mjs'],outfile:fileURLToPath(new URL('desktop/frontend/companion.mjs',root)),legalComments:'eof'})
for(const file of ['renderer.mjs','character.glb','portrait.png'])await copyFile(new URL(`assets/avatar/${file}`,root),new URL(`desktop/frontend/${file}`,root))
await copyFile(new URL('src/avatar/companion.html',root),new URL('desktop/frontend/index.html',root))
await mkdir(new URL('assets/avatar/desktop/',root),{recursive:true})
const files={}
for(const file of DESKTOP_ASSET_FILES){
  await copyFile(new URL(`desktop/frontend/${file}`,root),new URL(`assets/avatar/desktop/${file}`,root))
  files[file]=createHash('sha256').update(await readFile(new URL(`desktop/frontend/${file}`,root))).digest('hex')
}
await writeFile(new URL('assets/avatar/desktop/manifest.json',root),JSON.stringify({protocol:AVATAR_UI_PROTOCOL,files},null,2)+'\n')
console.log('Built shared avatar renderer, GLB and native companion frontend')
