/** Desktop transport without a cookie jar: real storage, locks, frames and rating UI. */
import assert from 'node:assert/strict'
import {readFile,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {chromium} from 'playwright'
import {RemoteFeedback} from '../../src/host/feedback-files.mjs'
import {FeedbackService} from '../../src/host/feedback-store.mjs'
const dir=await mkdtemp(join(tmpdir(),'duet-browser-identity-'))
const store=new RemoteFeedback(()=>({}),{keyPath:join(dir,'key')})
const rows=[];store.insert=async row=>{rows.push(row);return {archive_id:'fixture'}}
const feedback=new FeedbackService(store)
let issued=0,configCalls=0,failed=false
const errors=[]
const browser=await chromium.launch({headless:true})
try{
  const context=await browser.newContext()
  await context.route('http://localhost:19212/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname
    if(path==='/client/identity.mjs')return route.fulfill({contentType:'text/javascript',body:`
      import {createIdentityClient} from '/implementation/identity.mjs';
      const client=createIdentityClient({location:{protocol:'dsh-app:'},localStorage,navigator,fetch:window.fetch.bind(window)});
      export const identityFetch=client.fetch,identityVoiceProtocols=client.voiceProtocols;`})
    if(path.endsWith('.mjs')){
      const source=path==='/implementation/identity.mjs'?'client/identity.mjs':path.slice(1)
      return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../src/'+source,import.meta.url),'utf8')})
    }
    if(path==='/duplex-control/api/voice/config'){
      configCalls++
      assert.equal(req.headers()['x-duet-identity-transport'],'local-v1')
      assert.equal(req.headers().cookie,undefined)
      if(failed)return route.fulfill({status:503,json:{}})
      const token=store.ensureCredential({headers:req.headers()},{setHeader(){issued++}})
      // Simulate the Desktop response bridge: discard Set-Cookie.
      return route.fulfill({json:{feedback_enabled:true,feedback_identity:token}})
    }
    if(path==='/duplex-control/api/feedback'){
      const result=await feedback.submit({headers:req.headers()},req.postDataJSON())
      return route.fulfill({status:201,json:result})
    }
    return route.fulfill({contentType:'text/html',body:`<button id="anchor">duet</button>
      ${path==='/'?'<iframe src="/frame"></iframe>':''}
      <script type="module">
      import {identityFetch,identityVoiceProtocols} from '/client/identity.mjs';
      import {mountRating} from '/client/feedback.mjs';
      window.load=()=>identityFetch('/duplex-control/api/voice/config');
      window.protocols=identityVoiceProtocols;
      window.show=ticket=>mountRating(document.querySelector('#anchor'),ticket);
      await load();window.ready=true;
      </script>`})
  })
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message))
  const other=await context.newPage();other.on('pageerror',e=>errors.push(e.message))
  await Promise.all([page.goto('http://localhost:19212/'),other.goto('http://localhost:19212/other')])
  await Promise.all([page.waitForFunction(()=>window.ready),other.waitForFunction(()=>window.ready)])
  await page.frames()[1].waitForFunction(()=>window.ready)
  assert.equal(configCalls,3);assert.equal(issued,1)
  const protocols=await page.evaluate(()=>protocols())
  assert.equal(protocols[0],'duet-voice-v1')
  assert.deepEqual(await other.evaluate(()=>protocols()),protocols)
  assert.deepEqual(await page.frames()[1].evaluate(()=>protocols()),protocols)
  const token=protocols[1].slice('duet-identity.'.length)
  const ticket=feedback.open({headers:{'sec-websocket-protocol':protocols.join(',')}},'fixture-session','online')
  assert.ok(ticket);feedback.close(ticket)
  await page.evaluate(ticket=>show(ticket),ticket)
  const rating=page.getByRole('region',{name:'本次语音体验评分'})
  await rating.getByRole('button',{name:'5 星',exact:true}).click()
  await rating.getByRole('button',{name:'提交评分',exact:true}).click()
  await rating.waitFor({state:'detached'})
  assert.equal(rows.length,1)
  assert.equal(rows[0].user_id,store.userId({headers:{'x-duet-identity':token}}))
  await page.reload();await page.waitForFunction(()=>window.ready)
  assert.deepEqual(await page.evaluate(()=>protocols()),protocols);assert.equal(issued,1)
  failed=true;assert.equal(await page.evaluate(async()=>(await load()).status),503)
  assert.deepEqual(await page.evaluate(()=>protocols()),protocols);failed=false
  await page.evaluate(()=>localStorage.setItem('dsh-duet.feedback-identity.v1','tampered'))
  await page.evaluate(()=>load())
  assert.equal(issued,2);assert.notDeepEqual(await page.evaluate(()=>protocols()),protocols)
  assert.deepEqual(await context.cookies(),[]);assert.deepEqual(errors,[])
  console.log('Desktop identity: concurrent pages/iframe issue once, no cookies, shared signed ID, rating saved, reload stable, failure preserves identity, corrupt storage recovers')
}finally{await browser.close();await rm(dir,{recursive:true,force:true})}
