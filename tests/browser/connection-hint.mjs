import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 360 } })
  await page.route('http://127.0.0.1:19359/**', async route => {
    if (new URL(route.request().url()).pathname.endsWith('.mjs')) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../../src/client/connection-hint.mjs', import.meta.url), 'utf8') })
    return route.fulfill({ contentType: 'text/html', body: '<div id="controls" style="position:absolute;bottom:30px;left:16px"><button data-voice="mic">交互</button></div><script type="module">import {mountConnectionHint} from "/hint.mjs"; window.hint=mountConnectionHint(document.querySelector("#controls"));</script>' })
  })
  await page.goto('http://127.0.0.1:19359/')
  await page.clock.install()
  const hint = page.locator('[data-duet-connection-hint]')
  const update = (mode, ready, teaching = false) => page.evaluate(s => window.hint.update(s), { mode, ready, teaching })
  await update('online', false); assert.equal(await hint.isVisible(), false)
  await update('tts_only', true); assert.equal(await hint.isVisible(), false)
  await update('online', true); assert.equal(await hint.isVisible(), true)
  assert.equal(await hint.innerText(), '连接成功，可以试试对我说“你好”。')
  const box = await hint.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 480)
  await page.clock.fastForward(8001); assert.equal(await hint.isVisible(), false)
  await update('online', true); assert.equal(await hint.isVisible(), false)
  await update('off', false); await update('online', true)
  assert.equal(await hint.isVisible(), true)
  await page.keyboard.press('Escape'); assert.equal(await hint.isVisible(), false)
  await update('off', false); await update('online', true, true)
  assert.equal(await hint.isVisible(), false)
  await update('off', false); await update('online', true)
  await update('tts_only', true); assert.equal(await hint.isVisible(), false)
  await page.evaluate(() => window.hint.dispose()); assert.equal(await hint.count(), 0)
  console.log('Connection hint: ready-only, online-only, once per connection, timeout, escape, mode switch, teaching suppression, disposal passed')
} finally { await browser.close() }
