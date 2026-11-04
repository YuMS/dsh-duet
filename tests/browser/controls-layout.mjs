import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
 for(const deviceScaleFactor of [1,1.25,1.5,2]){
  const page = await browser.newPage({ viewport: { width: 700, height: 500 },deviceScaleFactor })
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.route('http://layout.test/**', async route => {
    if (route.request().url().endsWith('.mjs')) return route.fulfill({ contentType: 'text/javascript', body:
      await readFile(new URL('../../src/client/controls-layout.mjs', import.meta.url), 'utf8') })
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><body style="margin:0;background:#111827;color:#fff;font-family:system-ui">
      <aside id="sidebar" style="position:absolute;left:0;bottom:12px;width:64px;overflow:hidden;transform:translateZ(0)">
        <div id="controls" style="display:flex;align-items:center;gap:4px"><span id="dsh-duet-entry">duet<span data-duet-mark style="color:#ed9b35">.</span></span><button data-voice="mic">交互</button><button data-voice="speaker">播报</button><a href="#settings">设置</a></div>
        <button id="hostSettings" style="width:36px;height:32px;margin:0 14px">DSH</button>
      </aside><script type="module">import {mountControlsLayout} from '/layout.mjs';window.stop=mountControlsLayout(document.querySelector('#controls'));window.clicks=0;document.querySelector('[data-voice=mic]').onclick=()=>clicks++;</script>` })
  })
  await page.goto('http://layout.test/')
  const entry=page.locator('#dsh-duet-entry'),actions=page.locator('[data-duet-actions]')
  await page.waitForFunction(()=>document.querySelector('#controls').dataset.compact==='true')
  assert.equal(await entry.textContent(),'d.')
  assert.ok((await page.locator('#controls').boundingBox()).height<=40)
  assert.equal(await actions.isVisible(),false)
  await page.locator('#hostSettings').click()
  await entry.hover();await actions.waitFor({state:'visible'})
  const hostBefore=await page.locator('#hostSettings').boundingBox()
  const box=await actions.boundingBox();assert.ok(box.x>=64 && box.x+box.width<=700)
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2)
  await page.waitForTimeout(300);assert.equal(await actions.isVisible(),true)
  await page.mouse.move(400,100)
  await page.waitForTimeout(300);assert.equal(await actions.isVisible(),false)
  await entry.hover()
  await page.locator('[data-voice=mic]').click();assert.equal(await page.evaluate(()=>clicks),1)
  assert.deepEqual(await page.locator('#hostSettings').boundingBox(),hostBefore)
  await page.mouse.click(400,100);assert.equal(await actions.isVisible(),false)
  await entry.focus();await page.keyboard.press('Enter')
  assert.equal(await page.locator('[data-voice=mic]').evaluate(e=>e===document.activeElement),true)
  await page.keyboard.press('Tab');assert.equal(await page.locator('[data-voice=speaker]').evaluate(e=>e===document.activeElement),true)
  await page.keyboard.press('Escape');assert.equal(await actions.isVisible(),false)
  await page.evaluate(()=>document.querySelector('#controls').dispatchEvent(new CustomEvent('duet:reveal-controls',{detail:true})))
  assert.equal(await actions.isVisible(),true)
  await page.mouse.click(400,100);assert.equal(await actions.isVisible(),true)
  await page.evaluate(()=>document.querySelector('#controls').dispatchEvent(new CustomEvent('duet:reveal-controls',{detail:false})))
  await page.waitForTimeout(300);assert.equal(await actions.isVisible(),false)
  await page.evaluate(()=>document.querySelector('#sidebar').style.width='240px')
  await page.waitForFunction(()=>document.querySelector('#controls').dataset.compact==='false')
  assert.equal(await entry.innerText(),'duet.');assert.equal(await actions.isVisible(),true)
  await page.evaluate(()=>{const s=document.querySelector('#sidebar');s.style.width='64px';s.style.left='636px'})
  await page.waitForFunction(()=>document.querySelector('#controls').dataset.compact==='true')
  await entry.hover();const edge=await actions.boundingBox();assert.ok(edge.x>=8 && edge.x+edge.width<=692)
  await page.evaluate(()=>stop());assert.equal(await actions.count(),0)
  assert.equal(await entry.innerText(),'duet.')
  // DSH 0.2: the immediate flex child stays wide; only its ancestors shrink.
  await page.evaluate(async()=>{
    const sidebar=document.querySelector('#sidebar'), controls=document.querySelector('#controls')
    sidebar.style.cssText='position:absolute;left:0;bottom:12px;width:280px;padding:0 12px;box-sizing:border-box;overflow:hidden'
    const contents=document.createElement('div');contents.style.display='contents'
    const footer=document.createElement('div');footer.id='footer';footer.style.cssText='display:flex;flex-direction:column;width:100%'
    const slot=document.createElement('div');slot.id='slot';slot.style.cssText='display:flex;width:256px;flex:none'
    sidebar.prepend(contents);contents.append(footer);footer.append(slot);slot.append(controls)
    const settings=document.querySelector('#hostSettings');settings.style.margin='0';slot.append(settings)
    window.stop=(await import('/layout.mjs')).mountControlsLayout(controls)
  })
  await page.waitForFunction(()=>document.querySelector('#controls').dataset.compact==='false')
  for(let i=0;i<2;i++){
    await page.evaluate(()=>{const s=document.querySelector('#sidebar');s.style.width='56px';s.style.padding='0 10px'})
    await page.waitForFunction(()=>document.querySelector('#controls').dataset.compact==='true')
    assert.equal(await entry.textContent(),'d.')
    assert.ok(await page.locator('#slot').evaluate(e=>e.getBoundingClientRect().width)<=36)
    const launcher=await entry.boundingBox(),settings=await page.locator('#hostSettings').boundingBox()
    assert.ok(settings.y>=launcher.y+launcher.height)
    await entry.hover();await actions.waitFor({state:'visible'})
    const flyout=await actions.boundingBox();assert.ok(flyout.x>=56 && flyout.x+flyout.width<=700)
    await page.mouse.click(400,100)
    await page.evaluate(()=>{const s=document.querySelector('#sidebar');s.style.width='280px';s.style.padding='0 12px'})
    await page.waitForFunction(()=>document.querySelector('#controls').dataset.compact==='false')
    assert.equal(await entry.innerText(),'duet.');assert.equal(await actions.isVisible(),true)
  }
  await page.evaluate(()=>stop())
  assert.equal(await page.locator('#slot').getAttribute('data-duet-compact-host'),null)
  await page.evaluate(async()=>{
    const controls=document.querySelector('#controls'),button=document.createElement('button');button.dataset.duetAvatarToggle='';button.textContent='头像';controls.insertBefore(button,controls.querySelector('[data-voice=mic]'));
    window.stop=(await import('/layout.mjs')).mountControlsLayout(controls);
    document.querySelector('#sidebar').style.width='56px';
  })
  await page.waitForFunction(()=>document.querySelector('#controls').dataset.compact==='true')
  await entry.hover();await actions.waitFor({state:'visible'})
  assert.equal(await actions.locator('button').first().getAttribute('data-duet-avatar-toggle'),'')
  assert.equal(await actions.locator('[data-duet-avatar-toggle]').isVisible(),true)
  await page.evaluate(()=>stop())
  // A Windows-style intrinsic flex slot used to get stuck at the width of d.
  // Exercise the actual production label and four icon buttons, not text mocks.
  await page.evaluate(async()=>{
    const sidebar=document.querySelector('#sidebar'),slot=document.querySelector('#slot'),controls=document.querySelector('#controls')
    sidebar.style.width='300px';sidebar.style.padding='0 12px'
    slot.style.cssText='display:flex;width:max-content;max-width:100%;align-self:flex-start;align-items:center'
    controls.style.cssText='display:flex;gap:4px;position:relative;padding:6px 8px;align-items:center;margin:4px 8px;max-width:100%'
    const entry=document.querySelector('#dsh-duet-entry')
    entry.style.cssText='font-family:Segoe UI,Arial,sans-serif;font-size:28px;font-weight:700;letter-spacing:-1.1px;line-height:1.1;margin-right:auto;padding:4px'
    for(const button of controls.querySelectorAll('button,a')){
      button.style.cssText='display:flex;flex-shrink:0;padding:5px;border:0;box-sizing:border-box'
      button.innerHTML='<svg width="20" height="20" viewBox="0 0 20 20"><rect x="4" y="4" width="12" height="12" fill="currentColor"/></svg>'
    }
    window.stop=(await import('/layout.mjs')).mountControlsLayout(controls)
  })
  for(let i=0;i<3;i++){
    await page.evaluate(()=>document.querySelector('#sidebar').style.width='56px')
    await page.waitForFunction(()=>document.querySelector('#dsh-duet-entry').textContent==='d.')
    await page.evaluate(()=>document.querySelector('#sidebar').style.width='300px')
    await page.waitForFunction(()=>document.querySelector('#controls').dataset.compact==='false',{},{timeout:3000})
    assert.equal(await entry.innerText(),'duet.')
    await page.evaluate(()=>document.querySelector('#sidebar').style.width='210px')
    await page.waitForFunction(()=>document.querySelector('#controls').dataset.compact==='true')
    assert.equal(await entry.textContent(),'duet.','expanded medium sidebar must retain full brand even with flyout controls')
    const brandLine=await entry.evaluate(e=>{const range=document.createRange();range.selectNodeContents(e.firstChild);const text=range.getBoundingClientRect(),dot=e.querySelector('[data-duet-mark]').getBoundingClientRect();return {textTop:text.top,textBottom:text.bottom,dotTop:dot.top,dotBottom:dot.bottom,textRight:text.right,dotLeft:dot.left}})
    assert.ok(brandLine.dotTop<brandLine.textBottom&&brandLine.textTop<brandLine.dotBottom&&brandLine.dotLeft>=brandLine.textRight-1,'brand must remain on one line')
    await entry.click();await actions.waitFor({state:'visible'})
    const footer=await page.locator('#hostSettings').boundingBox(),brand=await entry.boundingBox()
    assert.ok(footer.x>=brand.x+brand.width||footer.y>=brand.y+brand.height,'host settings overlap brand')
    await page.mouse.click(500,100)
  }
  await page.evaluate(()=>document.querySelector('#sidebar').style.width='300px')
  await page.waitForFunction(()=>document.querySelector('#controls').dataset.compact==='false')
  const visibleRects=await page.locator('#dsh-duet-entry,#dsh-duet-actions button,#dsh-duet-actions a,#hostSettings').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom}}))
  const sidebarRight=(await page.locator('#sidebar').boundingBox()).width-12
  for(const r of visibleRects)assert.ok(r.right<=sidebarRight+1,'wide sidebar clips controls: '+JSON.stringify(visibleRects))
  for(let i=0;i<visibleRects.length;i++)for(let j=i+1;j<visibleRects.length;j++){
    const a=visibleRects[i],b=visibleRects[j]
    assert.ok(a.right<=b.x+1||b.right<=a.x+1||a.bottom<=b.y+1||b.bottom<=a.y+1,'wide sidebar controls overlap')
  }
  await page.screenshot({path:new URL(`../../../evidence/sidebar-wide-${deviceScaleFactor}.png`,import.meta.url).pathname})
  await page.evaluate(()=>stop())
  assert.equal(await page.locator('#slot').getAttribute('data-duet-compact-host'),null)
  assert.deepEqual(errors,[])
  console.log(`Controls at scale ${deviceScaleFactor}: host settings preserved, narrow rail, full medium brand, intrinsic-slot recovery, no clipping/overlap, keyboard and cleanup passed`)
  await page.close()
 }
} finally { await browser.close() }
