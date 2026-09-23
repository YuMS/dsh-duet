export const DEFAULT_CONNECTION_HINT='连接成功，可以试试对我说“你好”。'
export function connectionGuidance(text,revision=null){
  const valid=typeof text==='string'&&text.trim().length>0&&text.length<=200&&!/[\u0000-\u001f\u007f<>]/.test(text)
  return {text:valid?text.trim():DEFAULT_CONNECTION_HINT,source:valid?'router':'default',
    revision:valid&&Number.isSafeInteger(revision)&&revision>=0?revision:null}
}
export function normalizeGuidance(value){
  return value?.source==='router'?connectionGuidance(value.text,value.revision):connectionGuidance(null)
}
