/** Real DOM lifecycle for the Desktop-only settings container; no user data. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.route('http://localhost:19210/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/transport.mjs') return route.fulfill({ contentType: 'text/javascript', body:
      await readFile(new URL('../../src/client/transport.mjs', import.meta.url), 'utf8') })
    if (path === '/duet/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>设置已加载</h1>' })
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<a href="/duet/" target="_blank">duet 设置</a>
      <script type="module">
        import { bindSettingsLink } from '/transport.mjs';
        window.dispose = bindSettingsLink(document.querySelector('a'), { location: { protocol: 'dsh-app:' } });
      </script>` })
  })
  await page.goto('http://localhost:19210/')
  await page.waitForFunction(() => typeof window.dispose === 'function')
  await page.getByRole('link', { name: 'duet 设置' }).click()
  await page.frameLocator('iframe').getByRole('heading', { name: '设置已加载' }).waitFor()
  assert.equal(page.url(), 'http://localhost:19210/')
  assert.equal(page.context().pages().length, 1)
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('dialog').count(), 0)
  await page.getByRole('link', { name: 'duet 设置' }).click()
  await page.getByRole('button', { name: '关闭设置' }).click()
  assert.equal(await page.locator('iframe').count(), 0)
  await page.getByRole('link', { name: 'duet 设置' }).click()
  await page.evaluate(() => dispose())
  assert.equal(await page.locator('dialog').count(), 0)
  assert.deepEqual(errors, [])
  console.log('Desktop settings: iframe loads, no popup/navigation, Escape/button close, reopen and disposal passed')
} finally { await browser.close() }
