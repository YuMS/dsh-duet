/** Public trial connection details distributed with the plugin. */
export const DEFAULT_DUET_URL = 'wss://duet-router-acc.router.dsh-duet.com/ws?protocol=realtime_v2'
export const PUBLIC_TRIAL_AUTHORIZATION = "ZTZhZWI4YzA3ODcyZWI2NzZhZjU4MDk3NGE3NGUxODQ2MjgxYWVjYQ=="

export const PUBLIC_TRIAL_ACCELERATOR_URL = 'ws://47.117.104.188/ws?protocol=realtime_v2'

export function isPublicTrialEndpoint(value) {
  const url = new URL(value)
  return [DEFAULT_DUET_URL, PUBLIC_TRIAL_ACCELERATOR_URL].some(value => {
    const expected = new URL(value)
    return url.origin === expected.origin && url.pathname === expected.pathname && !url.username && !url.password
  })
}

/** Never forward the trial credential to a user-selected third-party service. */
export function publicServiceAuthorization(endpoints) {
  const urls = Object.values(endpoints)
  return urls.length && urls.every(isPublicTrialEndpoint) ? PUBLIC_TRIAL_AUTHORIZATION : ''
}
