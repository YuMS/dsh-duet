import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  let writes = 0
  await page.route('http://127.0.0.1:19349/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('.mjs')) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../../src/client/feedback.mjs', import.meta.url), 'utf8') })
    if (path.endsWith('/api/feedback')) { writes++; return route.fulfill({ status: 201, json: { persisted: true } }) }
    return route.fulfill({ contentType: 'text/html', body: `<button id="anchor" style="position:fixed;bottom:85px;left:18px;height:36px;width:180px">duet modes</button><script type="module">import {mountRating} from '/feedback.mjs';window.show=()=>mountRating(document.querySelector('#anchor'),'fixture-ticket');</script>` })
  })
  await page.goto('http://127.0.0.1:19349/')
  await page.clock.install()
  await page.evaluate(() => show())
  const panel = page.getByRole('region', { name: '本次语音体验评分' })
  const anchor = await page.locator('#anchor').boundingBox(), box = await panel.boundingBox()
  assert.ok(box.y + box.height < anchor.y)
  assert.equal(await panel.locator('p').count(), 0)
  assert.equal(await panel.getByRole('button').count(), 7)
  await page.clock.fastForward(5000)
  assert.match(await panel.innerText(), /5s/)
  await page.clock.fastForward(5000)
  assert.equal(await panel.count(), 0)
  assert.equal(writes, 0)
  await page.evaluate(() => show())
  await panel.getByRole('button', { name: '5 星', exact: true }).click()
  await panel.getByRole('button', { name: '提交评分', exact: true }).click()
  await panel.waitFor({ state: 'detached' })
  assert.equal(writes, 1)
  console.log('Rating: no overlap, title/stars/two buttons, 10-second countdown, no auto-submit, saved on explicit click passed')
} finally { await browser.close() }
