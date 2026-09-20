/** Browser-local, opt-in shortcuts. Never register OS-wide keyboard hooks. */
export const SHORTCUTS_KEY = 'dsh-duet.shortcuts.v1'
const empty = () => ({speaker:null, mic:null})
const valid = value => value && /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Space|Enter|Arrow(Up|Down|Left|Right))$/.test(value.code)
  && ['ctrl','alt','meta','shift'].every(k=>typeof value[k]==='boolean') && (value.ctrl||value.alt||value.meta)
const same = (a,b) => a && b && ['code','ctrl','alt','meta','shift'].every(k=>a[k]===b[k])
const storage = () => {try{return globalThis.localStorage}catch{return null}}
export function readShortcuts(store=storage()) {
  try {
    const value=JSON.parse(store?.getItem(SHORTCUTS_KEY)||'{}'), result=empty()
    for(const kind of ['speaker','mic'])if(valid(value[kind]))result[kind]=value[kind]
    if(same(result.speaker,result.mic))return empty()
    return result
  } catch {return empty()}
}
export function shortcutFromEvent(event) {
  if(event.repeat||event.isComposing||event.getModifierState?.('AltGraph'))return null
  const value={code:event.code,ctrl:event.ctrlKey,alt:event.altKey,meta:event.metaKey,shift:event.shiftKey}
  return valid(value)?value:null
}
export function shortcutLabel(value) {
  if(!value)return ''
  return [value.ctrl&&'Ctrl',value.alt&&'Alt',value.meta&&'⌘',value.shift&&'Shift',
    value.code.replace(/^Key|^Digit/,'').replace('Space','空格').replace('Arrow','')].filter(Boolean).join(' + ')
}
export function saveShortcut(kind,value,store=storage()) {
  if(!['speaker','mic'].includes(kind)||value!==null&&!valid(value))throw Error('invalid_shortcut')
  if(!store)throw Error('storage_unavailable')
  const settings=readShortcuts(store)
  if(value&&same(value,settings[kind==='mic'?'speaker':'mic']))throw Error('shortcut_conflict')
  settings[kind]=value
  store.setItem(SHORTCUTS_KEY,JSON.stringify(settings))
  return settings
}
export function bindDuetShortcuts(activate,target=window,store=storage()) {
  const handler=event=>{
    if(event.defaultPrevented||document.querySelector('dialog[open]'))return
    const value=shortcutFromEvent(event)
    if(!value)return
    const settings=readShortcuts(store)
    const kind=['speaker','mic'].find(k=>same(value,settings[k]))
    if(!kind)return
    event.preventDefault();event.stopPropagation();activate(kind)
  }
  target.addEventListener('keydown',handler,true)
  return ()=>target.removeEventListener('keydown',handler,true)
}
export function mountShortcutSettings({speaker,mic,clearSpeaker,clearMic,status},store=storage()) {
  const fields={speaker,mic}
  const refresh=()=>{const settings=readShortcuts(store);for(const kind of ['speaker','mic'])fields[kind].value=shortcutLabel(settings[kind])}
  const save=(kind,value)=>{
    try{saveShortcut(kind,value,store);status.textContent=value?'快捷键已保存。':'快捷键已清除。'}
    catch(error){status.textContent=error.message==='shortcut_conflict'?'两个模式请使用不同快捷键。':'无法保存，请允许浏览器存储后重试。'}
    refresh()
  }
  for(const kind of ['speaker','mic'])fields[kind].onkeydown=event=>{
    if(event.key==='Tab')return
    event.preventDefault();event.stopPropagation()
    if(event.key==='Escape'){fields[kind].blur();return}
    if(['Control','Alt','Meta','Shift'].includes(event.key))return
    const value=shortcutFromEvent(event)
    if(!value){status.textContent='请使用 Ctrl、Alt 或 ⌘ 加其他按键。';return}
    save(kind,value)
  }
  clearSpeaker.onclick=()=>save('speaker',null);clearMic.onclick=()=>save('mic',null)
  const changed=event=>{if(event.key===SHORTCUTS_KEY||event.key===null)refresh()}
  window.addEventListener('storage',changed);refresh()
  return ()=>{window.removeEventListener('storage',changed);for(const field of Object.values(fields))field.onkeydown=null;clearSpeaker.onclick=clearMic.onclick=null}
}
