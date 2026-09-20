/** Host boundary for a durable feedback adapter. No in-memory success fallback.
 * Store contract: userId(req) resolves authenticated/stable identity synchronously;
 * insert(record) commits durably and enforces (user_id, request_id) idempotency,
 * plus one rating per (user_id, session_id). Reuse with different content conflicts.
 */
import { randomUUID } from 'node:crypto'

export class FeedbackService {
  constructor(store, { now = Date.now } = {}) {
    this.store = store; this.now = now; this.sessions = new Map()
  }
  get enabled() { return Boolean(this.store?.userId && this.store?.insert) }
  user(req) {
    if(!this.enabled)throw Error('feedback_unavailable')
    const user=this.store.userId(req)
    if(typeof user!=='string'||!user||user.length>256)throw Error('feedback_identity_unavailable')
    return user
  }
  prune() { for(const [key,s] of this.sessions)if(this.now()-s.opened>86400000)this.sessions.delete(key) }
  open(req, sessionId, mode) {
    if(!this.enabled)return null
    this.prune()
    if(this.sessions.size>=2048||typeof sessionId!=='string'||!sessionId||sessionId.length>256)return null
    try {
      const ticket=randomUUID()
      this.sessions.set(ticket,{user:this.user(req),sessionId,mode,opened:this.now(),closed:false})
      return ticket
    } catch { return null } // Feedback availability must not break voice.
  }
  close(ticket) { const s=this.sessions.get(ticket);if(s)s.closed=true }
  async submit(req, input) {
    const user=this.user(req);this.prune()
    if(!input||Array.isArray(input)||!['text','rating'].includes(input.kind))throw Error('invalid_feedback')
    const allowed=['kind','request_id','text',...(input.kind==='rating'?['rating','session_ticket']:[])]
    if(Object.keys(input).some(k=>!allowed.includes(k)))throw Error('invalid_feedback_fields')
    if(typeof input.request_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.request_id))throw Error('invalid_feedback_id')
    const text=input.text??''
    if(typeof text!=='string'||text.length>5000||text.includes('\0')||(input.kind==='text'&&!text.trim()))throw Error('invalid_feedback_text')
    let session
    if(input.kind==='rating'){
      if(!Number.isInteger(input.rating)||input.rating<1||input.rating>5)throw Error('invalid_feedback_rating')
      session=this.sessions.get(input.session_ticket)
      if(!session||session.user!==user||!session.closed)throw Error('feedback_session_unavailable')
    }
    const record={request_id:input.request_id,user_id:user,kind:input.kind,text:text.trim(),
      rating:session?input.rating:null,session_id:session?.sessionId??null,mode:session?.mode??null,
      created_at:new Date(this.now()).toISOString()}
    const saved=await this.store.insert(record)
    return {persisted:true,request_id:input.request_id,...(saved?.archive_id?{archive_id:saved.archive_id}:{})}
  }
}
