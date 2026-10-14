/** No live DSH or voice service: two isolated pages and an intercepted Host API. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
const browser = await chromium.launch({headless:true,args:['--no-sandbox']})
try {
  const context = await browser.newContext(), cancels = []
  await context.route('http://127.0.0.1:19363/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('.mjs')) return route.fulfill({contentType:'text/javascript',body:await readFile(
      new URL('../../src/'+path.replace('/duet/assets/',''),import.meta.url),'utf8')})
    if (path.endsWith('/api/sessions')) return route.fulfill({json:{sessions:[],duet_rpc_capabilities:['stop_task_v1']}})
    if (path.endsWith('/cancel')) {
      cancels.push({owner:route.request().headers()['x-duet-browser-client'],path})
      return route.fulfill({json:{accepted:true}})
    }
    return route.fulfill({contentType:'text/html',body:`<script type="module">
      import {HarnessRPCExecutor} from '/duet/assets/client/rpc.mjs';
      window.current='s1';window.reply=null;
      window.start=async owner=>{
        window.rpc=new HarnessRPCExecutor(r=>window.reply=r,fetch,undefined,null,rows=>rows,{id:owner,focused:()=>current});
        await rpc.execute({type:'harness.rpc.request',request_id:crypto.randomUUID().replaceAll('-',''),connection_id:'a'.repeat(32),method:'GET',path:'/api/sessions'});
      };
      window.stop=async(sid,focus)=>rpc.execute({type:'harness.rpc.request',request_id:crypto.randomUUID().replaceAll('-',''),connection_id:'a'.repeat(32),method:'POST',path:'/api/sessions/'+sid+'/cancel',payload:{execution_id:'b'.repeat(36),require_focus:focus}});
      window.ready=true;
    </script>`})
  })
  const a = await context.newPage(), b = await context.newPage()
  for (const page of [a,b]) {await page.goto('http://127.0.0.1:19363/');await page.waitForFunction(()=>window.ready)}
  await a.evaluate(()=>start('page-a'));await b.evaluate(()=>start('page-b'))
  await b.evaluate(()=>current='s2')
  await a.evaluate(()=>stop('s1',true))
  assert.deepEqual(cancels,[{owner:'page-a',path:'/duplex-control/api/sessions/s1/cancel'}])
  assert.equal(await b.evaluate(()=>current),'s2')
  await a.evaluate(()=>current='s3')
  await a.evaluate(()=>stop('s1',true))
  assert.equal(await a.evaluate(()=>reply.body.error_code),'focus_conflict')
  assert.equal(cancels.length,1)
  await a.evaluate(()=>stop('s2',false))
  assert.equal(cancels[1].owner,'page-a')
  assert.equal(await a.evaluate(()=>current),'s3')
  await a.evaluate(()=>rpc.close())
  await a.evaluate(()=>stop('s1',false))
  assert.equal(cancels.length,2)
  console.log('stop_task_v1: two-page focus isolation, changed-focus rejection, explicit target and disconnect fencing passed')
} finally {await browser.close()}
