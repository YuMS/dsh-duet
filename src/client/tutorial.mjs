/** Opt-in walkthrough. All writes are limited to sessions created by this run. */
import {consumeTutorialRequest} from './tutorial-request.mjs?v=0.1.3'
export const TUTORIAL_KEY = 'dsh-duplex-tutorial-v1'
export const QUESTION = '什么是语音交互？请用一句话简单解释，不使用工具。'
export const INPUT = '用一句话介绍语音助手。'
export const EDIT = '用一句简短的话介绍语音助手。'
export const NARRATION = {
  modes_broadcast: '这个喇叭按钮是播报模式。在播报模式中，我只会为您简要播报完成的任务。',
  modes_interaction: '这个双向箭头按钮是交互模式。您可以让我输入、修改、发送消息，或者切换会话，也可以和我自由聊天。两个模式只能选一个，浅蓝色表示当前模式。点另一个按钮就能切换，再点当前按钮就会关闭。',
  broadcast: '现在我们来演示在 DSH 问一个简单的问题，看看我的播报吧。',
  input: '现在开始演示交互模式，但是这次不需要您来说话，我会通过语音为您讲解。比如，您可以说，输入，用一句话介绍语音助手。内容就会出现在输入框里。',
  edit: '如果想改一改，可以接着说，把一句话改成一句简短的话。',
  clear: '想重新写，可以说，清空输入框。',
  reinput: '然后，您可以说，输入，用一句简短的话介绍语音助手。我们就重新写好了。',
  send: '满意的话，您可以说，发送，或者，提交。这次点击确认后，我帮您提交。',
  switch: '想看看另一个会话，可以说，切换到播报教学的会话。',
}

const aborted = () => new DOMException('教学已停止', 'AbortError')
export class TutorialRun {
  constructor(adapter) {
    this.a = adapter; this.controller = new AbortController(); this.owned = new Set()
    this.first = null; this.second = null; this.expected = ''; this.duetOwned = false
    this.step = 'new'; this.busy = false; this.submitted = false
  }
  check() { if (this.controller.signal.aborted) throw aborted() }
  async operation(fn) {
    this.check(); if (this.busy) throw Error('上一步尚未完成')
    this.busy = true
    try { const value = await fn(); this.check(); return value } finally { this.busy = false }
  }
  require(step) { this.check(); if (this.step !== step) throw Error('教学步骤已变化，请重新开始') }
  async create(name) {
    const id = await this.a.create(name, this.controller.signal)
    // Even if the request finished after exit, no further action may follow it.
    this.owned.add(id); this.check()
    await this.a.focus(id, this.controller.signal); this.check()
    return id
  }
  async begin(consent) { return this.operation(async () => {
    if (!consent?.sound || !consent?.chat) throw Error('请先确认声音和教学消息授权')
    this.require('new'); if (this.a.mode() !== 'off') throw Error('请先关闭正在使用的语音，再开始教学')
    this.first = await this.create('duet 教学 · 播报'); this.step = 'consent'
  }) }
  assertFocus(id) {
    this.check()
    if (!this.owned.has(id) || this.a.current() !== id) throw Error('当前会话已切换，教学停止，未修改其他会话')
  }
  async write(id, text, expected) {
    this.assertFocus(id)
    await this.a.write(id, text, expected, this.controller.signal); this.check()
    this.expected = text
  }
  async broadcast(consent) { return this.operation(async () => {
    this.require('consent')
    if (!consent?.sound || !consent?.chat) { await this.stop(); throw Error('未确认声音和真实聊天，教学已停止') }
    this.assertFocus(this.first); this.duetOwned = true
    await this.a.narrate('broadcast', this.controller.signal); this.assertFocus(this.first)
    await this.a.enableBroadcast(this.controller.signal); this.check()
    await this.write(this.first, QUESTION, '')
    this.a.status('任务完成后，我会为您简要播报。')
    this.assertFocus(this.first)
    const job = await this.a.submit(this.first, QUESTION, this.controller.signal)
    this.submitted = true; this.check()
    await this.a.waitBroadcast(job, this.controller.signal); this.check()
    await this.a.off(); this.duetOwned = false; this.step = 'input'
  }) }
  async explainMode(mode) { return this.operation(async () => {
    this.require('consent'); this.assertFocus(this.first)
    if (!['broadcast','interaction'].includes(mode)) throw Error('未知教学模式')
    await this.a.narrate('modes_'+mode, this.controller.signal)
  }) }
  async input() { return this.operation(async () => {
    this.require('input'); this.assertFocus(this.first)
    this.second = await this.create('duet 教学 · 交互'); this.expected = ''
    await this.a.narrate('input', this.controller.signal); this.check()
    await this.write(this.second, INPUT, ''); this.step = 'edit'
  }) }
  async edit() { return this.operation(async () => {
    this.require('edit'); this.assertFocus(this.second)
    await this.a.narrate('edit', this.controller.signal); this.check()
    await this.write(this.second, EDIT, INPUT); this.step = 'clear'
  }) }
  async clear() { return this.operation(async () => {
    this.require('clear'); this.assertFocus(this.second)
    await this.a.narrate('clear', this.controller.signal); this.check()
    await this.write(this.second, '', EDIT); this.step = 'reinput'
  }) }
  async reinput() { return this.operation(async () => {
    this.require('reinput'); this.assertFocus(this.second)
    await this.a.narrate('reinput', this.controller.signal); this.check()
    await this.write(this.second, EDIT, ''); this.step = 'send_explain'
  }) }
  async explainSend() { return this.operation(async () => {
    this.require('send_explain'); this.assertFocus(this.second)
    await this.a.narrate('send', this.controller.signal); this.step = 'send_consent'
  }) }
  async send(confirmed) { return this.operation(async () => {
    this.require('send_consent')
    if (!confirmed) { await this.stop(); return }
    this.assertFocus(this.second)
    await this.a.submit(this.second, EDIT, this.controller.signal)
    this.submitted = true; this.check(); this.step = 'switch'
  }) }
  async switchSession() { return this.operation(async () => {
    this.require('switch'); this.assertFocus(this.second)
    await this.a.narrate('switch', this.controller.signal); this.assertFocus(this.second)
    await this.a.focus(this.first, this.controller.signal); this.check(); this.step = 'done'
  }) }
  async stop() {
    this.controller.abort(); this.a.stopNarration()
    if (this.duetOwned) { this.duetOwned = false; await this.a.off() }
  }
}

export function mountTutorial({ controls, adapter }) {
  const element = (tag, text, parent) => { const n = document.createElement(tag); if (text) n.textContent = text; parent?.append(n); return n }
  let run, closed = false, panel, highlight, pointer, lockRelease, active = false
  const get = (store, key) => { try { return store.getItem(key) } catch { return null } }
  const put = (store, key, value) => { try { store.setItem(key, value) } catch { /* private browsing */ } }
  const style = element('style', null, document.head)
  style.textContent = `
    .duet-tutorial-pointer{position:fixed;z-index:100011;pointer-events:none;color:#80c2ff;filter:drop-shadow(0 2px 5px #0008)}
    .duet-tutorial-mode{display:flex;align-items:center;gap:12px;margin:14px 0}.duet-tutorial-mode svg{width:24px;height:24px;color:#80c2ff;flex-shrink:0}
    .duet-tutorial{position:fixed;z-index:100010;width:min(380px,calc(100vw - 28px));max-height:calc(100vh - 28px);overflow:auto;box-sizing:border-box;padding:22px;color:#edf3ff;background:#17212f;border:1px solid #52647d;border-radius:18px;box-shadow:0 14px 50px #0007;font:14px/1.65 system-ui,sans-serif}
    .duet-tutorial h3{font-size:19px;margin:4px 0 12px}.duet-tutorial p{white-space:pre-wrap;margin:10px 0}.duet-tutorial small{color:#b1c5dc}.duet-tutorial footer{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}.duet-tutorial button{font:inherit;padding:7px 13px;border:1px solid #66809c;border-radius:9px;background:transparent;color:inherit;cursor:pointer}.duet-tutorial button.primary{background:#80c2ff;color:#112035;border-color:transparent;font-weight:650}.duet-tutorial button:disabled{opacity:.45;cursor:wait}.duet-tutorial label{display:flex;align-items:flex-start;gap:10px;margin:12px 0;cursor:pointer}.duet-tutorial input{margin-top:6px}.duet-tutorial-highlight{position:fixed;z-index:100009;pointer-events:none;border:2px solid #80c2ff;border-radius:12px;box-shadow:0 0 0 5px #80c2ff25;transition:all .15s}.duet-tutorial-help{border:0;background:transparent;color:inherit;cursor:pointer;font:600 12px system-ui;padding:5px}
  `
  let target = controls, targetSelector = '#dsh-duet-controls'
  const position = () => {
    if (!panel) return
    target = document.querySelector(targetSelector) || controls
    const rect = (target?.isConnected ? target : controls).getBoundingClientRect()
    const width = panel.offsetWidth, height = panel.offsetHeight
    const beside = rect.right + 16 + width < innerWidth
    const left = beside ? rect.right + 16 : Math.max(14, innerWidth - width - 14)
    const top = !beside && rect.top > height + 30 ? rect.top - height - 16 : rect.top
    panel.style.left = left + 'px'; panel.style.top = Math.max(14, Math.min(top, innerHeight - height - 14)) + 'px'
    if (highlight) Object.assign(highlight.style, {left:rect.left-4+'px',top:rect.top-4+'px',width:rect.width+8+'px',height:rect.height+8+'px'})
    if (pointer) {
      const above=rect.top>=55
      Object.assign(pointer.style,{left:rect.left+rect.width/2-14+'px',top:(above?rect.top-46:rect.bottom+10)+'px',transform:above?'':'rotate(180deg)'})
    }
  }
  const dismiss = async (forever=false) => {
    closed = true; put(sessionStorage,TUTORIAL_KEY,'closed'); if (forever) put(localStorage,TUTORIAL_KEY,'dismissed')
    panel?.remove(); panel=null; highlight?.remove(); highlight=null; pointer?.remove();pointer=null
    await run?.stop(); active=false; lockRelease?.(); lockRelease=null
  }
  const button = (parent, text, callback, primary=false) => {
    const b = element('button', text, parent); b.type='button'; if(primary)b.className='primary'
    b.onclick=callback; return b
  }
  const show = (title, text, actions=[], selector, finished=false) => {
    if(closed)return
    panel?.remove(); highlight?.remove();pointer?.remove();pointer=null
    targetSelector = selector || '#dsh-duet-controls'
    target = document.querySelector(targetSelector) || controls
    highlight = element('div',null,document.body); highlight.className='duet-tutorial-highlight'; highlight.setAttribute('aria-hidden','true')
    highlight.dataset.target=targetSelector
    if(selector==='[data-voice="speaker"]'||selector==='[data-voice="mic"]'){
      pointer=document.createElementNS('http://www.w3.org/2000/svg','svg');pointer.classList.add('duet-tutorial-pointer')
      pointer.setAttribute('viewBox','0 0 28 36');pointer.setAttribute('width','28');pointer.setAttribute('height','36');pointer.setAttribute('aria-hidden','true')
      pointer.innerHTML='<path d="M14 2v28m-8-8 8 8 8-8" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
      document.body.append(pointer)
    }
    panel=element('section',null,document.body); panel.className='duet-tutorial'; panel.setAttribute('role','region'); panel.setAttribute('aria-label','duet 使用教学')
    element('small', finished?'duet':active ? 'duet / GUIDED TOUR · 可随时退出' : 'WELCOME TO duet',panel)
    element('h3',title,panel); element('p',text,panel)
    const footer=element('footer',null,panel)
    for(const [text,fn] of actions) button(footer,text,fn,true)
    if(!finished)button(footer,active?'退出教学':'关闭',()=>{void dismiss()})
    if(!active&&!finished)button(footer,'不再提醒',()=>{void dismiss(true)})
    position(); return {panel,footer}
  }
  const fail = async error => {
    if(closed || error.name==='AbortError')return
    const owner=run
    await owner?.stop();if(run!==owner)return
    active=false;lockRelease?.();lockRelease=null
    if (showWorkspaceIssue(error.message)) return
    show('教学已暂停', `${error.message}\n不会继续发送或修改。已经提交的任务仍会保留。`, [['重新开始',welcome]])
  }
  const showWorkspaceIssue = issue => {
    const messages = {
      workspace_required: ['请先创建 workspace', '请先在 DSH 中创建一个 workspace，再回来开始教学。'],
      workspace_loading: ['正在加载 workspace', '请稍等片刻，再试一次。'],
      workspace_unavailable: ['暂时无法读取 workspace', '请检查 DSH 的 workspace 是否正常加载，再试一次。'],
    }
    if (!messages[issue]) return false
    show(...messages[issue], [['重新检查', welcome]])
    return true
  }
  const act = async (title,text,fn,next,selector,pause=0) => {
    if(run?.busy)return
    const owner=run
    show(title,text,[],selector)
    try {
      await fn()
      if(pause)await new Promise(resolve=>setTimeout(resolve,pause))
      if(!closed && run===owner && !owner.controller.signal.aborted)await next()
    } catch(e){if(run===owner)void fail(e)}
  }
  const composerSelector = '[data-composer-input]'
  const done = () => {
    put(localStorage,TUTORIAL_KEY,'completed')
    const view=show('现在您可以自己试试了', '', [['完成',()=>{void dismiss()}]],undefined,true)
    if(!view)return
    for(const [kind,text] of [['mic','交互模式'],['speaker','播报模式']]){
      const row=element('div');row.className='duet-tutorial-mode'
      const icon=controls.querySelector(`[data-voice="${kind}"] svg`)?.cloneNode(true)
      if(icon)row.append(icon)
      element('span',text,row);view.panel.insertBefore(row,view.footer)
    }
    position()
  }
  const switchStep = () => act('再试试切换会话','“切换到播报教学的会话。”',()=>run.switchSession(),done,'[data-slot="sidebar.sessions"]',700)
  const sendConsent = () => show('准备好了，就发出去吧', '点击确认后，我帮您提交。', [['确认发送',()=>act('发送中','马上就好…',()=>run.send(true),switchStep,composerSelector)]],composerSelector)
  const sendStep = () => act('满意了，就说“发送”','您也可以说“提交”。',()=>run.explainSend(),sendConsent,composerSelector)
  const reinputStep = () => act('再输入一句','您可以说：“输入，用一句简短的话介绍语音助手。”',()=>run.reinput(),sendStep,composerSelector,1000)
  const clearStep = () => act('想重新写，就清空','“清空输入框。”',()=>run.clear(),reinputStep,composerSelector,1000)
  const editStep = () => act('想改哪里，直接告诉我','“把一句话改成一句简短的话。”',()=>run.edit(),clearStep,composerSelector,1000)
  const inputStep = () => act('接下来，试试交互模式','现在开始演示交互模式，但是这次不需要您来说话，我会通过语音为您讲解。',()=>run.input(),editStep,composerSelector,1000)
  const broadcastStep = () => act('播报模式教学','现在我们来演示在 DSH 问一个简单的问题，看看我的播报吧。',()=>run.broadcast({sound:true,chat:true}),inputStep,'[data-voice="speaker"]',700)
  const interactionIntro = () => act('双向箭头 · 交互模式','您可以用语音输入、修改、发送消息、切换会话，也可以和我自由聊天。',()=>run.explainMode('interaction'),broadcastStep,'[data-voice="mic"]')
  const broadcastIntro = () => act('喇叭 · 播报模式','在播报模式中，我只会为您简要播报完成的任务。',()=>run.explainMode('broadcast'),interactionIntro,'[data-voice="speaker"]')
  async function start(consent) {
    if(active)return
    if(!consent?.sound||!consent?.chat){welcome();return}
    closed=false
    if(showWorkspaceIssue(adapter.workspaceIssue?.()))return
    if(adapter.mode()!=='off'){show('先结束当前语音','请先关闭语音模式，再开始教学。',[['重新检查',welcome]]);return}
    if(!navigator.locks){show('当前浏览器暂不支持教学','请使用新版 Chrome 或 Edge 打开 DSH。');return}
    try {
      await navigator.locks.request('dsh-duplex-tutorial-owner',{ifAvailable:true},async lock=>{
        if(!lock){show('另一个页面正在教学','请先关闭另一个页面的教学。');return}
        active=true;run=new TutorialRun({...adapter,status:text=>{const p=panel?.querySelector('p');if(p)p.textContent=text}})
        const owner=run
        const held=new Promise(resolve=>{lockRelease=resolve})
        // Exit releases ownership immediately, even while an old async operation
        // is winding down. act ignores callbacks belonging to an older run.
        void act('我们开始吧','先准备一个练习用的会话…',async()=>{await adapter.unlock();owner.check();await owner.begin(consent)},broadcastIntro)
        await held
      })
    }catch(e){fail(e)}
  }
  const welcome = () => {
    closed=false
    if(showWorkspaceIssue(adapter.workspaceIssue?.()))return
    const view=show('来试试用声音操作吧','我会带您体验播报模式和交互模式。\n开始前，请完成以下准备：')
    if(!view)return
    const check=text=>{const label=element('label'),input=element('input',null,label);input.type='checkbox';element('span',text,label);view.panel.insertBefore(label,view.footer);return input}
    const sound=check('声音已打开'),chat=check('同意本教程通过dsh发送消息（会产生模型用量）')
    const b=button(view.footer,'开始教学',()=>{
      if(showWorkspaceIssue(adapter.workspaceIssue?.()))return
      b.disabled=true
      const consent={sound:sound.checked,chat:chat.checked}
      // User gesture unlocks audio before either mode is demonstrated.
      void adapter.unlock().then(()=>{if(!closed&&view.panel.isConnected)return start(consent)}).catch(fail)
    },true)
    b.disabled=true;sound.onchange=chat.onchange=()=>{b.disabled=!(sound.checked&&chat.checked)}
    position()
  }
  const open = () => { if(!active)welcome() }
  const onKey=e=>{if(e.key==='Escape'&&panel)void dismiss()}
  window.addEventListener('resize',position);window.addEventListener('scroll',position,true);window.addEventListener('keydown',onKey)
  const layoutTimer=setInterval(position,300)
  const url = new URL(location.href)
  const requested = url.searchParams.get('live_tutorial') === '1'
  if(requested){url.searchParams.delete('live_tutorial');history.replaceState(history.state,'',url)}
  const handoff = () => {
    try { if(consumeTutorialRequest(localStorage, document.visibilityState==='visible'))open() } catch { /* Storage may be disabled. */ }
  }
  window.addEventListener('storage',handoff)
  window.addEventListener('focus',handoff)
  document.addEventListener('visibilitychange',handoff)
  if(requested || (!get(localStorage,TUTORIAL_KEY)&&!get(sessionStorage,TUTORIAL_KEY)))welcome()
  handoff()
  return {open,get active(){return active},dispose(){void dismiss();clearInterval(layoutTimer);style.remove();window.removeEventListener('resize',position);window.removeEventListener('scroll',position,true);window.removeEventListener('keydown',onKey);window.removeEventListener('storage',handoff);window.removeEventListener('focus',handoff);document.removeEventListener('visibilitychange',handoff)}}
}
