/** Default private plugin storage; legacy files are copied once, never overwritten. */
import {existsSync,mkdirSync,copyFileSync,chmodSync,linkSync,unlinkSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {homedir} from 'node:os'
import {randomUUID} from 'node:crypto'

export function duetHome(){
  return join(process.env.DSH_HOME||join(homedir(),'.dsh'),'dsh-duet')
}

export function defaultStateFile(name){
  const target=join(duetHome(),name)
  const legacy=join(dirname(duetHome()),'duplex-control',name)
  if(existsSync(target)||!existsSync(legacy))return target
  const temp=`${target}.${randomUUID()}.tmp`
  try {
    mkdirSync(dirname(target),{recursive:true,mode:0o700})
    copyFileSync(legacy,temp)
    chmodSync(temp,0o600)
    // Publish atomically without overwriting another process's completed migration.
    try{linkSync(temp,target)}catch(error){if(error.code!=='EEXIST')throw error}
    return target
  }catch{
    // A read-only/full disk must not discard settings or rotate the feedback identity.
    console.warn('[duet] Storage migration unavailable; keeping legacy file until next startup.')
    return legacy
  }finally{try{unlinkSync(temp)}catch{}}
}
