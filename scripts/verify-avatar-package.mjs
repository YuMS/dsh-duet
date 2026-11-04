import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
import {readdir} from 'node:fs/promises'
import {PLATFORMS, verifyHelpers} from './lib/avatar-package.mjs'
const args=process.argv.slice(2)
if(args.length && !['--platforms','--package-root'].includes(args[0]))throw Error('Usage: verify-avatar-package.mjs [--platforms keys... | --package-root path]')
if(args[0]==='--package-root'&&args.length!==2)throw Error('Provide one extracted package directory')
const root=fileURLToPath(new URL('../',import.meta.url))
const artifactRoot=args[0]==='--package-root'?resolve(args[1]):root
const keys=args[0]==='--platforms'?args.slice(1):PLATFORMS
if(args[0]!=='--platforms' && JSON.stringify((await readdir(resolve(artifactRoot,'desktop/bin'))).sort())!==JSON.stringify([...PLATFORMS].sort()))throw Error('Release must contain exactly the supported platform directories: '+PLATFORMS.join(', '))
console.log('Verified helpers:',(await verifyHelpers(root,keys,artifactRoot)).join(', '))
