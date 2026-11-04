import test from 'node:test'
import assert from 'node:assert/strict'
import {AvatarHeartbeat} from '../../src/shared/avatar.mjs'
for(const interval of [1000,15000]){
 test(`heartbeat ${interval}: suspension grace, genuine silence and clock rollback`,()=>{
  const h=new AvatarHeartbeat(interval,0)
  assert.equal(h.expired(8*60*60*1000),false)
  const wake=8*60*60*1000
  for(let t=interval;t<=60000;t+=interval)assert.equal(h.expired(wake+t),false)
  assert.equal(h.expired(wake+60000+interval),true)
  h.touch(wake+60000+interval)
  assert.equal(h.expired(wake+60000+interval*2),false)
  assert.equal(h.expired(0),false)
 })
}
