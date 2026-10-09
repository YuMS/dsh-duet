/** Legacy HTTP completion waiters; current pages use the local event stream. */
export class ResultFeed {
  constructor() { this.waiters = new Set() }
  notify() { for (const done of [...this.waiters]) done() }
  wait(req, res, timeout = 25000) {
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer); this.waiters.delete(done)
        res.off('close', done); req.off('aborted', done); resolve()
      }
      const timer = setTimeout(done, timeout)
      this.waiters.add(done); res.once('close', done); req.once('aborted', done)
    })
  }
}
