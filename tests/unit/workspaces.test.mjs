import test from 'node:test'
import assert from 'node:assert/strict'
import { workspaceIssue, requireWorkspace, browserSessionCatalog } from '../../src/client/workspaces.mjs'
import { orderSessionCatalog } from '../../src/shared/catalog.mjs'

test('workspace readiness fails closed and follows creation and deletion', () => {
  let snapshot = { phase: 'pending', state: 'loading', items: [] }
  const ctx = { workspaces: { list: { getSnapshot: () => snapshot } } }
  assert.equal(workspaceIssue({}), 'workspace_loading')
  assert.throws(() => requireWorkspace(ctx), /workspace_loading/)
  snapshot = { phase: 'ready', state: 'idle', items: [] }
  assert.throws(() => requireWorkspace(ctx), /workspace_required/)
  snapshot.items.push({ workspaceId: 'w' })
  assert.doesNotThrow(() => requireWorkspace(ctx))
  snapshot.state = 'error'
  assert.equal(workspaceIssue(ctx), 'workspace_unavailable')
  snapshot = { phase: 'ready', state: 'idle', items: [] }
  assert.equal(workspaceIssue(ctx), 'workspace_required')
})

const ids = rows => rows.map(row => row.session_id)
const rows = [
  { session_id: 'old', workspace_id: 'w', updated_at: 10 },
  { session_id: 'recent', workspace_id: 'w', updated_at: 30 },
  { session_id: 'blank', workspace_id: 'w', blank: true, active: true, updated_at: 0 },
]
test('0.1.5 uses its persisted activity-promoted order and 0.1.6 derives recency', () => {
  const view = { groupBy: 'workspace', orderBy: 'updated', sessionOrderByAccount: { w: ['old', 'recent', 'blank'] } }
  assert.deepEqual(ids(orderSessionCatalog(rows, { ...view, sessionUpdatedAtByAccount: {} })), ['old', 'recent', 'blank'])
  assert.deepEqual(ids(orderSessionCatalog(rows, view)), ['blank', 'recent', 'old'])
  assert.deepEqual(ids(orderSessionCatalog(rows, { ...view, orderBy: 'manual' })), ['blank', 'old', 'recent'])
})
test('legacy first load and new flat lists fall back to current recency', () => {
  assert.deepEqual(ids(orderSessionCatalog(rows.slice(0, 2), { sessionUpdatedAtByAccount: {} })), ['recent', 'old'])
  const view = { groupBy: 'flat', orderBy: 'updated', sessionOrderByAccount: { __flat_session_order__: ['old', 'recent'] } }
  assert.deepEqual(ids(orderSessionCatalog(rows.slice(0, 2), view)), ['recent', 'old'])
  assert.deepEqual(ids(orderSessionCatalog(rows.slice(0, 2), { ...view, sessionUpdatedAtByAccount: {} })), ['old', 'recent'])
})
test('browser catalog uses live timestamps, archive state, and focus instead of stale host state', () => {
  const ctx = {
    sessions: { list: { getSnapshot: () => ({ current: 'old', byId: { old: { updatedAt: 100 } } }) } },
    workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: ['recent'] }) } },
  }
  assert.deepEqual(ids(browserSessionCatalog(ctx, rows)), ['old'])
})
