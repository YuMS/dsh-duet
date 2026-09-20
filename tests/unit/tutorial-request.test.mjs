import test from 'node:test'
import assert from 'node:assert/strict'
import {requestTutorial,consumeTutorialRequest,TUTORIAL_REQUEST_KEY} from '../../src/client/tutorial-request.mjs'
const storage=()=>{const data=new Map();return {getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)}}
test('settings handoff waits for a visible DSH page and consumes once',()=>{
  const s=storage();requestTutorial(s,100)
  assert.equal(consumeTutorialRequest(s,false,200),false)
  assert.ok(s.getItem(TUTORIAL_REQUEST_KEY))
  assert.equal(consumeTutorialRequest(s,true,200),true)
  assert.equal(consumeTutorialRequest(s,true,200),false)
})
test('stale, malformed and future handoffs cannot open teaching',()=>{
  const s=storage()
  for(const value of ['bad','null','{}',JSON.stringify({at:0}),JSON.stringify({at:700000})]){
    s.setItem(TUTORIAL_REQUEST_KEY,value)
    assert.equal(consumeTutorialRequest(s,true,600001),false)
    assert.equal(s.getItem(TUTORIAL_REQUEST_KEY),undefined)
  }
})
