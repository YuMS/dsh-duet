/** Two real browser pages; all DSH APIs/drafts are isolated fixtures. */
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chromium} from 'playwright'
const browser = await chromium.launch({headless:true,args:['--no-sandbox']})
try {
  const context = await browser.newContext()
  const claims=[], replies=[], errors=[]
  let pending=null, holdClaim=false, finishClaim
  await context.route('http://127.0.0.1:19362/**', async route => {
    const url=new URL(route.request().url()), path=url.pathname
    if(path.endsWith('.mjs')) return route.fulfill({contentType:'text/javascript',body:await readFile(
      new URL('../../src/'+path.replace('/duet/assets/',''),import.meta.url),'utf8')})
    if(path.includes('/api/composer/requests')) {
      if(path.endsWith('/claim')) {
        claims.push(route.request().postDataJSON().client_id)
        const send=()=>route.fulfill({json:{request:pending}})
        if(holdClaim){finishClaim=send;return}
        return send()
      }
      if(path.endsWith('/complete')) {
        replies.push(route.request().postDataJSON());pending=null
        return route.fulfill({json:{ok:true}})
      }
      // Deliberately hand the candidate to both pages: clients must also reject misrouting.
      return route.fulfill({json:{requests:pending?[pending]:[]}})
    }
    return route.fulfill({contentType:'text/html',body:`<script type="module">
      import {startComposerBridge} from '/duet/assets/client/composer-bridge.mjs';
      import {composerAccess,openLocalSession} from '/duet/assets/client/composer.mjs';
      window.current='s1';window.draft={draft:'',draftRev:0,phase:'plain'};
      window.ctx={sessions:{refresh:async()=>{},scope:id=>({id}),open:id=>{current=id},list:{getSnapshot:()=>({current})}},conversation:{input:{for:()=>({state:{getSnapshot:()=>({...draft})},setDraft:text=>{draft.draft=text;draft.draftRev++}})}}};
      window.start=id=>{window.stop=startComposerBridge(ctx,id)};
      window.read=()=>composerAccess(ctx).execute({method:'GET',path:'/api/sessions/s1/composer'});
      window.navigate=id=>openLocalSession(ctx,id);
      window.ready=true;
    </script>`})
  })
  const a=await context.newPage(), b=await context.newPage()
  for(const page of [a,b]){page.on('pageerror',error=>errors.push(error.message));await page.goto('http://127.0.0.1:19362/');await page.waitForFunction(()=>window.ready)}
  await a.evaluate(()=>{draft={draft:'A 的草稿',draftRev:6,phase:'plain'}})
  await b.evaluate(()=>{draft={draft:'B 的草稿',draftRev:0,phase:'plain'}})
  const snapshot=await a.evaluate(()=>read())
  assert.equal(snapshot.composer.text,'A 的草稿')
  await a.evaluate(()=>navigate('s2'))
  assert.equal(await b.evaluate(()=>current),'s1','A navigation must not affect B')
  pending={id:'r1',type:'consume',session_id:'s1',target_client_id:'connection-a',
    expected_revision:6,expected_hash:snapshot.composer.hash}
  await b.evaluate(()=>start('connection-b'));await a.evaluate(()=>start('connection-a'))
  const until=async fn=>{for(let i=0;i<100&&!fn();i++)await new Promise(r=>setTimeout(r,20));assert.ok(fn())}
  await until(()=>replies.length===1)
  assert.deepEqual(claims,['connection-a'])
  assert.equal(replies[0].composer.consumed_text,'A 的草稿')
  assert.equal(await b.evaluate(()=>draft.draft),'B 的草稿')
  await a.evaluate(()=>stop());await b.evaluate(()=>stop())
  // A delayed claim may arrive after disconnect. It must never write the draft.
  pending={id:'r2',type:'set',session_id:'s1',target_client_id:'connection-a-new',overwrite:true,text:'不应该写入'}
  holdClaim=true;await a.evaluate(()=>start('connection-a-new'))
  await until(()=>Boolean(finishClaim));await a.evaluate(()=>stop());await finishClaim().catch(()=>{})
  await a.waitForTimeout(100)
  assert.equal(await a.evaluate(()=>draft.draft),'')
  assert.equal(replies.length,1)
  assert.deepEqual(errors,[])
  console.log('Two-page isolation: local read/navigation, wrong-page claim refusal, disconnect fencing passed')
} finally {await browser.close()}
