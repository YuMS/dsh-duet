import test from 'node:test'
import assert from 'node:assert/strict'
import {readShortcuts,saveShortcut,shortcutFromEvent,shortcutLabel,SHORTCUTS_KEY} from '../../src/client/shortcuts.mjs'
const event = extra => ({code:'KeyB',ctrlKey:true,altKey:false,metaKey:false,shiftKey:true,...extra})
const store = () => {const map=new Map();return {getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v)}}
test('shortcuts default empty and require explicit modified keys',()=>{
  assert.deepEqual(readShortcuts(store()),{speaker:null,mic:null})
  assert.equal(shortcutFromEvent(event({ctrlKey:false})),null)
  assert.equal(shortcutFromEvent(event({repeat:true})),null)
  assert.equal(shortcutFromEvent(event({isComposing:true})),null)
  assert.equal(shortcutFromEvent(event({getModifierState:()=>true})),null)
  assert.equal(shortcutLabel(shortcutFromEvent(event())),'Ctrl + Shift + B')
})
test('save, duplicate rejection and clear are browser-local',()=>{
  const s=store(), key=shortcutFromEvent(event())
  saveShortcut('speaker',key,s)
  assert.deepEqual(readShortcuts(s).speaker,key)
  assert.throws(()=>saveShortcut('mic',key,s),/shortcut_conflict/)
  assert.equal(readShortcuts(s).mic,null)
  saveShortcut('speaker',null,s)
  saveShortcut('mic',key,s)
  assert.deepEqual(readShortcuts(s),{speaker:null,mic:key})
})
test('corrupt or unavailable preferences never enable shortcuts',()=>{
  assert.deepEqual(readShortcuts(null),{speaker:null,mic:null})
  assert.deepEqual(readShortcuts({getItem(){throw Error('denied')}}),{speaker:null,mic:null})
  const s=store();s.setItem(SHORTCUTS_KEY,'bad JSON')
  assert.deepEqual(readShortcuts(s),{speaker:null,mic:null})
  assert.throws(()=>saveShortcut('mic',null,null),/storage_unavailable/)
})
