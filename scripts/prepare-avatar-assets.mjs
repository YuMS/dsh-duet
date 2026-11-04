import {fileURLToPath} from 'node:url'
import {prepareResources,verifyResources} from './lib/avatar-resources.mjs'
const args=process.argv.slice(2),root=fileURLToPath(new URL('../',import.meta.url))
if(args.length&&!(args.length===1&&args[0]==='--check')&&!(args.length===2&&args[0]==='--from'&&args[1]))throw Error('Usage: node scripts/prepare-avatar-assets.mjs [--check | --from <export-directory>]')
const result=args[0]==='--check'?await verifyResources(root):await prepareResources(root,{from:args[0]==='--from'?args[1]:undefined})
console.log(`Verified avatar resources: ${result.lock.version} (${result.lock.rig})\n${result.directory}`)
