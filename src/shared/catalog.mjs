/** Mirror DSH workspace order, never the global activity-sorted search list. */
export const WORKSPACE_VIEW_KEY = 'dsh.workspace.view.v5'

export function readWorkspaceView() {
  try { return JSON.parse(globalThis.localStorage?.getItem(WORKSPACE_VIEW_KEY) || '{}') || {} }
  catch { return {} }
}

function reconcile(rows, ids) {
  const byId = new Map(rows.map(row => [row.session_id, row]))
  const ordered = []
  for (const id of Array.isArray(ids) ? ids : []) {
    if (!byId.has(id)) continue
    ordered.push(byId.get(id)); byId.delete(id)
  }
  return [...ordered, ...byId.values()]
}

export function orderSessionCatalog(rows, view = {}) {
  const visible = rows.filter(row => !row.archived && row.origin !== 'subagent' && (!row.blank || row.active))
  const accounts = view?.sessionOrderByAccount || {}
  if (view?.groupBy === 'flat') {
    const recent = [...visible].sort((a,b) => (b.updated_at || 0) - (a.updated_at || 0)
      || String(a.session_id).localeCompare(String(b.session_id)))
    return reconcile(recent, accounts.__flat_session_order__)
  }
  const groups = new Map()
  for (const row of visible) {
    const key = row.workspace_id || ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  return [...groups].flatMap(([key, members]) => reconcile(members, accounts[key]))
}

export function buildSessionCatalog(items, {workspaces = [], archivedIds = [], activeId, includeBlank = false} = {}) {
  const archived = new Set(archivedIds)
  const byId = new Map(items.filter(item => !archived.has(item.sessionId)
    && item.origin !== 'subagent' && (includeBlank || !item.blank || item.sessionId === activeId))
    .map(item => [item.sessionId, item]))
  const result = []
  const add = (id, workspaceId) => {
    const item = byId.get(id)
    if (!item) return
    byId.delete(id)
    result.push({session_id:id, label:item.projections?.values?.title || id,
      active:id === activeId, running:item.running, updated_at:item.updatedAt,
      cwd:item.cwd || '', workspace_id:workspaceId, archived:false,
      blank:!!item.blank, origin:item.origin})
  }
  for (const workspace of workspaces) {
    for (const id of workspace.sessionIds || []) add(id, workspace.id || workspace.workspaceId || '')
  }
  for (const id of [...byId.keys()]) add(id, '')
  return result
}
