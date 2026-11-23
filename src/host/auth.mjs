/** DSH 0.2.3 admits routes before dispatch; older hosts validate the request here. */
export function requestRejection(ctx, req, peer) {
  if (peer) return peer.principal?.kind === 'owner' && !peer.signal?.aborted ? null : 403
  const connection = ctx.connection
  if (typeof connection?.admit === 'function') {
    const admission = connection.admit(req)
    if (admission?.rejection) return admission.rejection
    const admitted = admission?.peer
    return admitted?.principal?.kind === 'owner' && !admitted.signal?.aborted ? null : 403
  }
  if (typeof connection?.requestRejection === 'function') return connection.requestRejection(req)
  return 503
}
