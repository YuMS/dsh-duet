import { spawnSync } from 'node:child_process'
import { mkdir, copyFile, chmod, cp, rm } from 'node:fs/promises'
import { avatarBinary } from '../src/host/avatar.mjs'
import { fileURLToPath } from 'node:url'
import {recordHelper, PLATFORMS} from './lib/avatar-package.mjs'
const root = new URL('../',import.meta.url)
const targets={darwin:{arm64:'aarch64-apple-darwin',x64:'x86_64-apple-darwin'},win32:{arm64:'aarch64-pc-windows-msvc',x64:'x86_64-pc-windows-msvc'},linux:{arm64:'aarch64-unknown-linux-gnu',x64:'x86_64-unknown-linux-gnu'}}
const target=targets[process.platform]?.[process.arch]
const key=`${process.platform}-${process.arch}`
if(!target||!PLATFORMS.includes(key))throw Error('Unsupported release platform or architecture')
const rust=spawnSync('rustc',['-vV'],{encoding:'utf8'})
if(rust.status!==0)throw Error('Rust toolchain missing. Install Rust on the target desktop machine before building the companion.')
const host=rust.stdout.match(/^host: (.+)$/m)?.[1]
if(host!==target)throw Error(`Node and Rust architectures differ (${process.platform}-${process.arch} / ${host}). Use matching native tools; no mislabeled helper will be packaged.`)
if(spawnSync('cargo',['--version'],{stdio:'ignore'}).status!==0)throw Error('Cargo is not available')
if(process.platform==='darwin'&&spawnSync('xcrun',['--find','clang'],{stdio:'ignore'}).status!==0)throw Error('Install Xcode Command Line Tools before building on macOS')
if(process.argv.includes('--check')){console.log(`Desktop build prerequisites found: ${target}`);process.exit(0)}
const build = spawnSync(process.execPath,[fileURLToPath(new URL('./build-avatar.mjs',import.meta.url))],{cwd:root,stdio:'inherit'})
if(build.status!==0)process.exit(build.status||1)
const cli=new URL('node_modules/@tauri-apps/cli/tauri.js',root)
const args=process.platform==='darwin'?['--bundles','app']:['--no-bundle']
const result=spawnSync(process.execPath,[fileURLToPath(cli),'build',...args,'--','--locked'],{cwd:new URL('desktop/',root),stdio:'inherit'})
if(result.status!==0)process.exit(result.status||1)
const destination=avatarBinary()
const directory=new URL(`desktop/bin/${key}/`,root)
await rm(directory,{recursive:true,force:true})
await mkdir(directory,{recursive:true})
if(process.platform==='darwin') {
  await cp(new URL('desktop/src-tauri/target/release/bundle/macos/duet companion.app',root),new URL('duet-avatar.app/',directory),{recursive:true})
  const app=fileURLToPath(new URL('duet-avatar.app/',directory))
  // Local/CI unsigned builds get an explicit ad-hoc signature. When a Developer
  // ID is configured, Tauri already signed/notarized the app: never replace it.
  if(!process.env.APPLE_SIGNING_IDENTITY && spawnSync('codesign',['--force','--deep','--sign','-','--timestamp=none',app],{stdio:'inherit'}).status!==0)throw Error('Ad-hoc app signing failed')
  if(spawnSync('codesign',['--verify','--deep','--strict',app],{stdio:'inherit'}).status!==0)throw Error('App signature verification failed')
}else await copyFile(new URL(`desktop/src-tauri/target/release/duet-avatar${process.platform==='win32'?'.exe':''}`,root),destination)
await chmod(destination,0o755)
await recordHelper(fileURLToPath(root),key)
console.log(`Built plugin companion and manifest: ${key}`)
