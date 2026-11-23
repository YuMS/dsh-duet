import test from 'node:test'
import assert from 'node:assert/strict'
import { requestRejection } from '../../src/host/auth.mjs'

test('admitted owner is accepted without calling removed authentication APIs', () => {
  const ctx = {get connection() { throw Error('do not authenticate twice') }}
  assert.equal(requestRejection(ctx, {}, {principal:{kind:'owner'}}), null)
  assert.equal(requestRejection(ctx, {}, {principal:{kind:'guest'}}), 403)
  assert.equal(requestRejection(ctx, {}, {principal:{kind:'owner'},signal:{aborted:true}}), 403)
})

test('new admission rejects anonymous and non-owner requests; missing API fails closed', () => {
  for (const code of [401,403,503]) {
    assert.equal(requestRejection({connection:{admit:()=>({rejection:code})}}, {}), code)
  }
  assert.equal(requestRejection({connection:{admit:()=>({peer:{principal:{kind:'owner'}}})}}, {}), null)
  assert.equal(requestRejection({connection:{admit:()=>({peer:{principal:{kind:'guest'}}})}}, {}), 403)
  assert.equal(requestRejection({connection:{}}, {}), 503)
})

test('old DSH authentication remains enforced', () => {
  for (const code of [null,401,403]) {
    assert.equal(requestRejection({connection:{requestRejection:()=>code}}, {}), code)
  }
})
