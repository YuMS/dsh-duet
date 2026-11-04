/** Assistant nickname validation, shared by settings and voice actions. */
export const NICKNAME_LIMIT = '昵称最多5个汉字或2个英文单词；中英混用最多5个字符'
export function normalizeNickname(value) {
  if (typeof value !== 'string') throw new Error(NICKNAME_LIMIT)
  const name = value.trim()
  const chinese = /^\p{Script=Han}{1,5}$/u.test(name)
  const english = /^[A-Za-z]+(?:['-][A-Za-z]+)*(?: [A-Za-z]+(?:['-][A-Za-z]+)*)?$/.test(name)
  const mixed = /\p{Script=Han}/u.test(name) && /[A-Za-z]/.test(name)
    && /^[\p{Script=Han}A-Za-z]+(?:[ '-][\p{Script=Han}A-Za-z]+)*$/u.test(name)
    && Array.from(name).length <= 5
  if (!chinese && !english && !mixed) throw new Error(NICKNAME_LIMIT)
  return name
}
