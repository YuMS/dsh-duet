import { WebSocketServer } from 'ws'

/** Authenticated local event stream. No timers that query DSH state. */
export function registerSyncFeed(ctx, { snapshot, touch, commands }) {
  const server = new WebSocketServer({ noServer: true, maxPayload: 16000 })
  const clients = new Set()
  const unregister = ctx.webServer.registerUpgrade({
    path: '/duplex-control/sync/ws',
    handler(req, socket, head) {
      let allowed = !req.headers.origin
      try { if (req.headers.origin) allowed = new URL(req.headers.origin).host === req.headers.host } catch {}
      if (!allowed || ctx.connection?.requestRejection(req) || clients.size >= 64) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return
      }
      server.handleUpgrade(req, socket, head, ws => {
        const c = { ws, cursor: null, epoch: null, owner: null, busy: false, dirty: false, timer: null }
        clients.add(c)
        const send = value => {
          if (ws.readyState !== 1) return
          const raw = JSON.stringify(value)
          if (Buffer.byteLength(raw) > 2_000_000 || ws.bufferedAmount > 2_000_000) { ws.close(1013, 'sync_backpressure'); return }
          ws.send(raw)
        }
        c.flush = async () => {
          if (c.busy || ws.readyState !== 1) { c.dirty = true; return }
          c.busy = true; c.dirty = false
          try {
            const value = await snapshot(c.cursor, c.epoch)
            c.epoch = value.epoch
            c.cursor ??= value.cursor
            c.sentCursor = value.cursor
            send({ type: 'harness.sync.snapshot', protocol: 'harness_sync_v1', ...value })
          } catch { ws.close(1011, 'sync_snapshot_failed') }
          finally { c.busy = false; if (c.dirty) c.schedule() }
        }
        c.schedule = () => { if (!c.timer) c.timer = setTimeout(() => { c.timer = null; void c.flush() }, 50) }
        c.commands = () => {
          if (c.owner) for (const request of commands(c.owner.client_id)) send({ type: 'harness.sync.command', request })
        }
        ws.on('message', raw => {
          try {
            const event = JSON.parse(raw)
            if (event.type === 'harness.sync.subscribe' && event.protocol === 'harness_sync_v1') {
              if (event.cursor != null && (!Number.isSafeInteger(event.cursor) || event.cursor < 0)) throw Error()
              c.cursor = event.cursor ?? null; c.epoch = event.epoch ?? null; c.schedule()
            } else if (event.type === 'harness.sync.received' && event.epoch === c.epoch) {
              if (!Number.isSafeInteger(event.cursor) || event.cursor < (c.cursor ?? 0) || event.cursor > c.sentCursor) throw Error()
              c.cursor = event.cursor
              if (event.more === true) c.schedule()
            } else if (event.type === 'harness.sync.refresh') c.schedule()
            else if (event.type === 'harness.sync.heartbeat') {
              const owner = event.owner
              if (owner !== null && (!owner || typeof owner.client_id !== 'string' || owner.client_id.length > 128
                || (owner.session_id !== null && typeof owner.session_id !== 'string'))) throw Error()
              c.owner = owner
              if (owner) touch(owner)
              c.commands()
              send({ type: 'harness.sync.alive' })
            } else throw Error()
          } catch { ws.close(1008, 'invalid_sync_message') }
        })
        ws.on('error', () => {})
        ws.on('close', () => { clearTimeout(c.timer); clients.delete(c) })
      })
    },
  })
  return {
    changed() { for (const c of clients) c.schedule() },
    commands() { for (const c of clients) c.commands() },
    close() { unregister(); for (const c of clients) c.ws.close(1001); server.close() },
  }
}
