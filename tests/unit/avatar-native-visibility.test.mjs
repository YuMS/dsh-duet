import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

const source=readFileSync(new URL('../../desktop/src-tauri/src/fullscreen.rs',import.meta.url),'utf8')
// DSW cannot run a Windows WebView. Guard the ordering that keeps Tao's cached
// VISIBLE bit aligned with the HWND when cursor passthrough rewrites styles.
function assertFrameworkVisibility(source) {
  const windows=source.split('#[cfg(target_os = "windows")]\nmod platform {')[1]?.split('#[cfg(not(any')[0]
  assert.ok(windows,'Windows visibility implementation exists')
  const show=windows.split('pub fn show(')[1]?.split('pub fn visible(')[0]
  const hide=windows.split('pub fn hide(')[1]
  assert.match(show,/window\.show\(\)\.map_err\([^\n]+\?;/)
  assert.ok(show.indexOf('window.show()')<show.indexOf('SetWindowPos(hwnd'))
  assert.match(hide,/window\.hide\(\)\.map_err\([^\n]+\?;/)
  assert.ok(hide.indexOf('window.hide()')<hide.indexOf('ShowWindow(window.hwnd()'))
  assert.match(source,/if target == applied && native_matches \{ return Ok\(\(\)\); \}/)
}
test('Windows visibility synchronizes framework flags before native fallback',()=>assertFrameworkVisibility(source))
test('guard rejects native-only show and hide regressions',()=>{
  for(const method of ['show','hide']) {
    const changed=source.replaceAll(`window.${method}().map_err(|e|e.to_string())?;`,'')
    assert.throws(()=>assertFrameworkVisibility(changed))
  }
})
test('guard rejects trusting HWND visibility without last applied intent',()=>{
  assert.throws(()=>assertFrameworkVisibility(source.replace('target == applied && native_matches','native_matches')))
})
