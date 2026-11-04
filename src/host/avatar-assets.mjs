import {readFileSync,realpathSync,statSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {AVATAR_UI_PROTOCOL} from '../shared/avatar-surface.mjs'
export const desktopAssetsPath=fileURLToPath(new URL('../../assets/avatar/desktop/',import.meta.url))
export const DESKTOP_ASSET_FILES=['index.html','companion.mjs','renderer.mjs','character.glb','portrait.png']
/** Verify the distributed local UI before starting a privileged native webview. */
export function verifyDesktopAssets(path=desktopAssetsPath) {
  const root=realpathSync(path),manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'))
  if(manifest.protocol!==AVATAR_UI_PROTOCOL||JSON.stringify(Object.keys(manifest.files||{}).sort())!==JSON.stringify([...DESKTOP_ASSET_FILES].sort()))throw Error('desktop_assets_incompatible')
  for(const file of DESKTOP_ASSET_FILES){
    const resolved=realpathSync(join(root,file))
    if(dirname(resolved)!==root||statSync(resolved).size>64*1024*1024)throw Error('desktop_assets_invalid')
    if(createHash('sha256').update(readFileSync(resolved)).digest('hex')!==manifest.files[file])throw Error('desktop_assets_damaged')
  }
  return root
}
