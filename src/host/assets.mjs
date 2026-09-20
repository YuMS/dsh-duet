/** Explicit public asset inventory. Host code and configuration are never served. */
const modules = {
  state: 'shared/state', catalog: 'shared/catalog',
  audio: 'client/audio', microphone: 'client/microphone', shortcuts: 'client/shortcuts',
  browser: 'client/browser', rpc: 'client/rpc', composer: 'client/composer',
  interactions: 'client/interactions', tutorial: 'client/tutorial',
  tutorial_adapter: 'client/tutorial-adapter', tutorial_request: 'client/tutorial-request',
  feedback: 'client/feedback', consent: 'client/consent',
}
const aliases = {
  state: 'DuetState as VoiceState', audio: 'DuetAudio as VoiceAudio',
  browser: 'mountDuet as mountVoice', shortcuts: 'bindDuetShortcuts as bindVoiceShortcuts',
}
const publicModules = new Set(Object.values(modules))

export function publicAsset(pathname) {
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
