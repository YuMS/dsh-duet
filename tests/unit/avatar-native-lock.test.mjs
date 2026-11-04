import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

// Source-level guard: DSW cannot exercise Wry's macOS main-thread dispatcher.
// This deliberately constrains the tiny critical section to pure hit testing.
export function assertPointerLockScope(source) {
 const match=source.match(/let \(over_avatar, ignore_cursor\) = \{([\s\S]*?)\n\s*\};/)
 assert.ok(match,'pointer decisions need an explicit guard scope')
 assert.match(match[1],/let Ok\(h\) = hit\.lock\(\) else \{ break \};/)
 const calculation=match[1].replace(/let Ok\(h\) = hit\.lock\(\) else \{ break \};/,'').replace(/\s/g,'')
 assert.equal(calculation,'(h.hits_avatar(x,y),h.ignores(x,y))','no window/API calls under HitState')
 const end=match.index+match[0].length
 assert.ok(source.indexOf('let size=win.inner_size().ok();')<match.index)
 assert.ok(source.indexOf('win.emit("avatar-pointer"')>end)
 assert.ok(source.indexOf('win.set_ignore_cursor_events(target)')>end)
 // The other two locks are statement-scoped assignments, released at semicolon.
 assert.equal((source.match(/\.lock\(\)/g)||[]).length,3,'review every newly added lock')
 assert.match(source,/\*state\.lock\(\)\.map_err\([^\n]+\? = value;/)
 assert.match(source,/\*state\.lock\(\)\.map_err\([^\n]+\?=HitMask::default\(\);\n\s*resize_avatar/)
}
const source=readFileSync(new URL('../../desktop/src-tauri/src/main.rs',import.meta.url),'utf8')
test('native pointer window calls run outside HitState guard',()=>assertPointerLockScope(source))
test('native lock guard rejects a window dispatcher call inside critical section',()=>{
 assert.throws(()=>assertPointerLockScope(source.replace('(h.hits_avatar(x,y), h.ignores(x,y))','win.inner_size().ok();\n                            (h.hits_avatar(x,y), h.ignores(x,y))')))
})
