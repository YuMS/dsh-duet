import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const entry = await readFile(new URL('../../src/client/entry.js', import.meta.url), 'utf8')
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  for (const scenario of ['missing-module', 'missing-dependency', 'mount-error', 'success', 'disposed']) {
    const page = await browser.newPage()
    let release
    const released = new Promise(resolve => { release = resolve })
    await page.route('http://127.0.0.1:19361/**', async route => {
      const path = new URL(route.request().url()).pathname
      if (path === '/entry.js') return route.fulfill({ contentType: 'text/javascript', body: entry })
      if (path.endsWith('.mjs')) {
        if (scenario === 'disposed') await released
        if (scenario === 'missing-module' || scenario === 'disposed' || path === '/missing.mjs') {
          return route.fulfill({ status: 404, body: 'Not found' })
        }
        const body = scenario === 'missing-dependency' ? 'import "/missing.mjs"; export function mountDuet() {}'
          : scenario === 'mount-error' ? 'export function mountDuet() { throw Error("test mount failure") }'
          : 'export function mountDuet() { window.mounted = true; return () => { window.cleaned = true } }'
        return route.fulfill({ contentType: 'text/javascript', body })
      }
      return route.fulfill({ contentType: 'text/html', body: `
        <meta charset="utf-8"><aside style="width:160px"><div data-slot="sidebar.settings"><button>Settings</button></div></aside>
        <script>window.cleanups=[];window.__ModuleLoader__={load:d=>d.factory().apply({effect:fn=>window.cleanups.push(fn())})};</script>
        <script src="/entry.js"></script>` })
    })
    await page.goto('http://127.0.0.1:19361/', { waitUntil: 'domcontentloaded' })
    const notice = page.locator('[data-duet-load-error]')
    if (scenario === 'disposed') {
      await page.evaluate(() => window.cleanups.forEach(fn => fn?.()))
      release()
      await page.waitForLoadState('networkidle')
      assert.equal(await notice.count(), 0)
      assert.equal(await page.locator('#dsh-duet-entry').count(), 0)
    } else if (scenario === 'success') {
      await page.waitForFunction(() => window.mounted)
      assert.equal(await notice.count(), 0)
      await page.evaluate(() => window.cleanups.forEach(fn => fn?.()))
      assert.equal(await page.evaluate(() => window.cleaned), true)
    } else {
      await notice.waitFor({ state: 'visible' })
      assert.match(await notice.innerText(), /如刚更新插件，请重启 DSH/)
      assert.equal(await notice.getAttribute('role'), 'status')
      // A rerender must restore the notice without creating duplicate observers/content.
      await page.locator('#dsh-duet-entry').evaluate(node => node.remove())
      await notice.waitFor({ state: 'visible' })
      assert.equal(await notice.count(), 1)
      await page.evaluate(() => window.cleanups.forEach(fn => fn?.()))
      assert.equal(await notice.count(), 0)
    }
    await page.close()
  }
  console.log('Entry loading: module/dependency failure, mount failure, success, rerender and disposal passed')
} finally { await browser.close() }
