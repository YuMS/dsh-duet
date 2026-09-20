/** Public trial connection details distributed with the plugin. */
export const DEFAULT_DUET_URL = 'ws://duet-router.1781574661016173.ap-southeast-1.pai-eas.aliyuncs.com/ws?protocol=realtime_v2'
export const PUBLIC_TRIAL_AUTHORIZATION = "ZTZhZWI4YzA3ODcyZWI2NzZhZjU4MDk3NGE3NGUxODQ2MjgxYWVjYQ=="

/** Never forward the trial credential to a user-selected third-party service. */
export function publicServiceAuthorization(endpoints) {
  const urls = Object.values(endpoints)
  return urls.length && urls.every(value => {
    const url = new URL(value), expected = new URL(DEFAULT_DUET_URL)
    return url.origin === expected.origin && url.pathname === expected.pathname && !url.username && !url.password
  }) ? PUBLIC_TRIAL_AUTHORIZATION : ''
}
