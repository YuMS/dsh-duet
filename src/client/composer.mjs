/** Browser-owned drafts: bounded snapshots and explicit overwrite/CAS edit policies. */
const fail = code => { const error = new Error(code); error.code = code; throw error }
const hash = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(text)))].map(v => v.toString(16).padStart(2, '0')).join('')

export function focusedSession(ctx) {
  const snapshot = ctx.sessions.list.getSnapshot()
  if ('current' in snapshot) return snapshot.current || null
  const selected = Object.entries(snapshot.byId || {}).filter(([, row]) => row.retainedBy?.mainView > 0)
  return selected.length === 1 ? selected[0][0] : null
}

/** Navigation is local to the page owning this connection, never a host broadcast. */
export async function openLocalSession(ctx, id, signal) {
  signal?.throwIfAborted()
  await ctx.sessions.refresh()
  signal?.throwIfAborted()
  const navigation = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : ctx.uiWorkspace
  if (navigation?.openSession) navigation.openSession(id)
  else ctx.sessions.open(id)
  const deadline = Date.now() + 3000
  while (focusedSession(ctx) !== id) {
    signal?.throwIfAborted()
    if (Date.now() > deadline) fail('focus_not_ready')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

export function composerAccess(ctx, label = id => id) {
  const focused = () => focusedSession(ctx)
  const inputFor = id => {
    const scope = id && ctx.sessions.scope(id)
    if (!scope) fail('session_not_ready')
    return ctx.conversation.input.for(scope)
  }
  const snapshot = async (id, input, stable = true) => {
    const before = input.state.getSnapshot()
    if (typeof before.draft !== 'string' || new TextEncoder().encode(before.draft).length > 64_000
      || !Number.isSafeInteger(before.draftRev) || before.draftRev < 0) fail('invalid_composer_snapshot')
    const digest = await hash(before.draft)
    const live = input.state.getSnapshot()
    if (stable && (live.draft !== before.draft || live.draftRev !== before.draftRev || live.phase !== before.phase)) fail('draft_conflict')
    return { session_id: id, session_name: label(id), text: before.draft,
      revision: before.draftRev, hash: digest, phase: before.phase }
  }
  const read = async () => {
    const id = focused()
    if (!id) return null
    const value = await snapshot(id, inputFor(id))
    if (focused() !== id) fail('focus_conflict')
    return value
  }
  const execute = async (request, signal) => {
    signal?.throwIfAborted()
    if (request.method === 'GET' && request.path === '/api/composer/focused') {
      const value = await read()
      if (!value) fail('session_not_ready')
      return { composer: value }
    }
    const match = request.path.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)\/composer$/)
    if (request.method === 'GET' && match) {
      const id = match[1]
      const value = await snapshot(id, inputFor(id))
      signal?.throwIfAborted()
      if (request.params?.require_focus === 'true' && focused() !== id) fail('focus_conflict')
      return { composer: value }
    }
    if (request.method !== 'PUT' || !match) return undefined
    const id = match[1], payload = request.payload || {}, input = inputFor(id)
    const overwrite = payload.overwrite === true
    const before = overwrite ? null : await snapshot(id, input)
    signal?.throwIfAborted()
    if (payload.require_focus && focused() !== id) fail('focus_conflict')
    if (typeof payload.text !== 'string' || new TextEncoder().encode(payload.text).length > 64_000) fail('invalid_composer_text')
    // No await between checking the live value and the synchronous write.
    const live = input.state.getSnapshot()
    if (live.phase !== 'plain') fail('composer_busy')
    if (!overwrite && (before.revision !== payload.expected_revision || before.hash !== payload.expected_hash
      || live.draftRev !== before.revision || live.draft !== before.text || live.phase !== before.phase)) fail('draft_conflict')
    input.setDraft(payload.text)
    // Capture the committed value synchronously; later keystrokes must not turn
    // a successful overwrite into a spurious conflict during asynchronous hashing.
    return { composer: await snapshot(id, input, false) }
  }
  return { read, execute, focused, inputFor }
}

export class ComposerPublisher {
  constructor(read, send, { now = Date.now, later = setTimeout, cancel = clearTimeout } = {}) {
    Object.assign(this, { read, send })
    // Window timer functions reject a class instance as their receiver.
    this.now = () => now()
    this.later = (fn, ms) => later(fn, ms)
    this.cancel = timer => cancel(timer)
    this.last = -Infinity; this.sequence = 0; this.closed = false; this.running = false
    this.dirty = false; this.timer = null; this.epoch = 0
  }
  changed({ focus = false } = {}) {
    if (this.closed) return
    this.dirty = true
    if (focus) { this.epoch++; this.last = -Infinity }
    if (this.running) return
    this.cancel(this.timer)
    this.timer = this.later(() => { this.timer = null; void this.publish() }, Math.max(0, this.last + 2000 - this.now()))
  }
  async publish() {
    if (this.closed || this.running) return
    this.running = true; this.dirty = false
    const epoch = this.epoch
    try {
      const composer = await this.read()
      if (!this.closed && epoch === this.epoch) {
        this.send({ type: 'harness.composer.update', sequence: ++this.sequence, composer })
        this.last = this.now()
      }
    } catch {
      // Invalidate a previous good snapshot; never invent an empty draft.
      if (!this.closed && epoch === this.epoch) {
        this.send({ type: 'harness.composer.update', sequence: ++this.sequence, composer: null })
        this.last = this.now()
      }
    } finally {
      this.running = false
      if (this.dirty) this.changed()
    }
  }
  close() { this.closed = true; this.cancel(this.timer) }
}

export function observeComposer(ctx, access, send) {
  const publisher = new ComposerPublisher(access.read, send)
  let id, input, unsubscribeInput
  const bind = () => {
    const nextId = access.focused()
    let nextInput
    try { nextInput = access.inputFor(nextId) } catch { /* unmounted */ }
    if (nextId === id && nextInput === input) return
    const focus = nextId !== id
    unsubscribeInput?.(); id = nextId; input = nextInput
    unsubscribeInput = input?.state.subscribe(() => publisher.changed())
    publisher.changed({ focus })
  }
  const unsubscribe = ctx.sessions.list.subscribe(bind)
  bind(); publisher.changed({ focus: true })
  // Refresh unchanged snapshots so an idle browser remains a valid cache source.
  const heartbeat = setInterval(() => { bind(); publisher.changed() }, 10_000)
  return () => { clearInterval(heartbeat); unsubscribe(); unsubscribeInput?.(); publisher.close() }
}
