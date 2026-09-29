import { sessionLabel } from './catalog.mjs'

export const MAX_RESULT_TEXT_LENGTH = 8000
export const LONG_RESULT_NOTICE = '这条任务消息内容较长，请在 DSH 会话中查看完整内容。'

/** Never truncate code into a misleading summary. The full result stays in DSH. */
export function broadcastText(text) {
  if (typeof text !== 'string') throw Error('invalid_external_message')
  return text.length > MAX_RESULT_TEXT_LENGTH ? LONG_RESULT_NOTICE : text
}

export function resultNotification(job, name) {
  return {
    type: 'external_message', message_id: `harness_${job.id}`,
    source: { session_id: job.session_id, session_name: sessionLabel(name, job.session_id),
      job_id: job.id, status: job.status === 'succeeded' ? 'completed' : 'failed' },
    text: broadcastText((job.status === 'succeeded' ? job.result : (job.error || job.result)) || '未返回结果。'),
  }
}
