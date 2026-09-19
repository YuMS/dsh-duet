/** Same-origin handoff: show the welcome only after returning to a DSH tab. */
export const TUTORIAL_REQUEST_KEY = 'dsh-duplex-tutorial-request-v1'
const MAX_AGE = 10 * 60 * 1000
export function requestTutorial(storage, now = Date.now()) {
  storage.setItem(TUTORIAL_REQUEST_KEY, JSON.stringify({at: now}))
}
export function consumeTutorialRequest(storage, visible, now = Date.now()) {
  if (!visible) return false
  const raw = storage.getItem(TUTORIAL_REQUEST_KEY)
  if (!raw) return false
  storage.removeItem(TUTORIAL_REQUEST_KEY)
  try {
    const {at} = JSON.parse(raw)
    return Number.isFinite(at) && now >= at && now - at < MAX_AGE
  } catch { return false }
}
