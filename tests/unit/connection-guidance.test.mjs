import test from 'node:test'
import assert from 'node:assert/strict'
import {connectionGuidance,normalizeGuidance,DEFAULT_CONNECTION_HINT} from '../../src/shared/connection-guidance.mjs'
import {EndpointDiscovery,DISCOVERY_INTERVAL_MS} from '../../src/host/endpoint-discovery.mjs'
import {DEFAULT_DUET_URL} from '../../src/host/service-defaults.mjs'

test('guidance falls back for missing, blank, unsafe and oversized text',()=>{
  for(const value of [null,undefined,'','  ','x'.repeat(201),'<script>alert(1)</script>','a\nb']){
    assert.deepEqual(connectionGuidance(value,5),{text:DEFAULT_CONNECTION_HINT,source:'default',revision:null})
  }
  assert.deepEqual(normalizeGuidance({source:'router',text:'可以试试说“打开新会话”。',revision:3}),{
    text:'可以试试说“打开新会话”。',source:'router',revision:3})
})
test('guidance shares daily refresh, survives failure, and old servers use default',async()=>{
  let now=0,offline=false,old=false
  const config={endpoints:{online:DEFAULT_DUET_URL}}
  const d=new EndpointDiscovery(()=>config,{cachePath:null,now:()=>now,fetchImpl:async()=>{
    if(offline)throw Error('offline')
    return new Response(JSON.stringify({schema_version:1,revision:4,recommended_endpoint:'',
      ...(!old?{connection_hint:'可以试试说“输入今天的计划”。'}:{})}))
  }})
  await d.refreshIfDue()
  const route=(await d.plan('online'))[0],hint=d.metadata(route).connection_hint
  assert.equal(hint.source,'router');assert.equal(hint.revision,4)
  offline=true;now+=DISCOVERY_INTERVAL_MS;await d.refreshIfDue()
  assert.deepEqual(d.metadata(route).connection_hint,hint)
  offline=false;old=true;now+=DISCOVERY_INTERVAL_MS;await d.refreshIfDue()
  assert.equal(d.metadata(route).connection_hint.text,DEFAULT_CONNECTION_HINT)
  assert.equal(d.metadata(route).connection_hint.source,'default')
})
