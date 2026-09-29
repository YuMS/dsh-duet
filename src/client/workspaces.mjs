/** Workspace readiness and browser-local session ordering shared by all voice paths. */
import { orderSessionCatalog, readWorkspaceView, sessionLabel } from '../shared/catalog.mjs'
import { focusedSession } from './composer.mjs'

export function workspaceIssue(ctx) {
  const snapshot = ctx.workspaces?.list?.getSnapshot()
  if (!snapshot || snapshot.phase !== 'ready' || snapshot.state === 'loading') return 'workspace_loading'
  if (snapshot.state === 'error') return 'workspace_unavailable'
  return snapshot.items.length ? null : 'workspace_required'
}

export function requireWorkspace(ctx) {
  const issue = workspaceIssue(ctx)
  if (issue) throw Error(issue)
}

/** Resolve at command time from this page, not the host's global focus/cwd. */
export function sessionCreationPayload(ctx, payload = {}) {
  requireWorkspace(ctx)
  const current = focusedSession(ctx)
  const items = ctx.workspaces.list.getSnapshot().items
  const workspace = items.find(item => item.sessionIds?.includes(current))
    ?? (!current && items.length === 1 ? items[0] : null)
  if (!workspace?.workspaceId) throw Object.assign(new Error('workspace_selection_required'), { code: 'workspace_selection_required' })
  return { name: payload.name, workspace_id: workspace.workspaceId }
}

export function browserSessionCatalog(ctx, rows) {
  const snapshot = ctx.sessions.list.getSnapshot()
  const active = focusedSession(ctx)
  const archived = new Set(ctx.workspaces?.list?.getSnapshot().archivedSessionIds || [])
  return orderSessionCatalog(rows.filter(row => !archived.has(row.session_id)).map(row => ({
    ...row, active: row.session_id === active,
    label: sessionLabel(row.label, row.session_id),
    updated_at: snapshot.byId?.[row.session_id]?.updatedAt ?? row.updated_at,
  })), readWorkspaceView())
}
