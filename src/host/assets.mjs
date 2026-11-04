/** Explicit public asset inventory. Host code and configuration are never served. */
const modules = {
  state: 'shared/state', catalog: 'shared/catalog',
  diagnostics: 'shared/diagnostics',
  result_notification: 'shared/result-notification',
  connection_guidance: 'shared/connection-guidance',
  audio: 'client/audio', microphone: 'client/microphone', shortcuts: 'client/shortcuts',
  browser: 'client/browser', rpc: 'client/rpc', composer: 'client/composer',
  composer_bridge: 'client/composer-bridge',
  harness_sync: 'client/harness-sync',
  local_sync: 'client/local-sync',
  interactions: 'client/interactions', tutorial: 'client/tutorial',
  tutorial_adapter: 'client/tutorial-adapter', tutorial_request: 'client/tutorial-request',
  feedback: 'client/feedback', consent: 'client/consent',
  connection_hint: 'client/connection-hint',
  controls_layout: 'client/controls-layout',
  notice: 'client/notice',
  workspaces: 'client/workspaces',
  transport: 'client/transport',
  identity: 'client/identity', identity_protocol: 'shared/identity',
  avatar: 'client/avatar', avatar_protocol: 'shared/avatar',
  avatar_activity: 'shared/avatar-activity',
  avatar_ui: 'shared/avatar-ui',
  avatar_menu: 'shared/avatar-menu', avatar_menu_ui: 'shared/avatar-menu-ui',
  avatar_tasks: 'client/avatar-tasks',
  avatar_surface: 'shared/avatar-surface', avatar_surfaces: 'client/avatar-surfaces',
  input_effect: 'client/input-effect',
}
const aliases = {
  state: 'DuetState as VoiceState', audio: 'DuetAudio as VoiceAudio',
  browser: 'mountDuet as mountVoice', shortcuts: 'bindDuetShortcuts as bindVoiceShortcuts',
}
const publicModules = new Set(Object.values(modules))

export function publicAsset(pathname) {
  const avatar = { '/duet/avatar/renderer.mjs':['renderer.mjs','text/javascript; charset=utf-8'],
    '/duet/avatar/character.glb':['character.glb','model/gltf-binary'],
    '/duet/avatar/portrait.png':['portrait.png','image/png'] }[pathname]
  if (avatar) return {url:new URL(`../../assets/avatar/${avatar[0]}`,import.meta.url),contentType:avatar[1],
    cacheControl:avatar[0].endsWith('.mjs')?'no-store':'private, max-age=3600'}
  const modern = pathname.match(/^\/duet\/assets\/(client|shared)\/([a-z-]+)\.mjs$/)
  if (modern && publicModules.has(`${modern[1]}/${modern[2]}`)) {
    return { url: new URL(`../${modern[1]}/${modern[2]}.mjs`, import.meta.url) }
  }
  // Old open pages may request their previous module URLs after an upgrade.
  const legacy = pathname.match(/^\/duplex-control\/deepseek_harness_voice_([a-z_]+)\.mjs$/)
  if (!legacy || !Object.hasOwn(modules, legacy[1])) return null
  const target = `/duet/assets/${modules[legacy[1]]}.mjs`
  return { body: `export * from '${target}';\n${aliases[legacy[1]] ? `export { ${aliases[legacy[1]]} } from '${target}';\n` : ''}` }
}
