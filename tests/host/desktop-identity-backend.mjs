/** Native Desktop fixture only: no model, raw transcripts, or remote feedback.
 * Run: node tests/host/desktop-identity-backend.mjs /absolute/path/evidence.json
 * Start Desktop with DUET_URL=ws://127.0.0.1:19876/ws and a separate DUET_SETTINGS_FILE.
 */
import http from 'node:http'
import {writeFileSync} from 'node:fs'
import {WebSocketServer} from 'ws'
if(!process.argv[2])throw Error('Provide the local aggregate evidence output path')
const ids=new Set(),sessions=new Map()
const summary={sessions:0,identified_sessions:0,distinct_users:0,ratings:0,text_feedback:0,feedback_identity_matches:true,credential_forwarded:false}
const save=()=>writeFileSync(process.argv[2],JSON.stringify(summary,null,2)+'\n')
const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json')
  if(req.method==='POST'&&req.url==='/feedback'){
    let body='';for await(const part of req)body+=part
    const record=JSON.parse(body)
    summary.feedback_identity_matches&&=record.kind==='rating'?sessions.get(record.session_id)===record.user_id:ids.has(record.user_id)
    if(record.kind==='rating')summary.ratings++;else summary.text_feedback++
    save();res.end(JSON.stringify({persisted:true,archive_id:'local-fixture/'+(summary.ratings+summary.text_feedback)}));return
  }
  if(req.url==='/api/service-info'){res.end(JSON.stringify({schema_version:1,models:{duplex:'local-fixture',tts:'local-fixture'}}));return}
  res.end(JSON.stringify({items:[],status:'ok'}))
})
const wss=new WebSocketServer({server})
wss.on('connection',(ws,req)=>{
  summary.credential_forwarded ||= Boolean(req.headers['x-duet-identity']||req.headers['sec-websocket-protocol'])
  ws.on('message',(raw,binary)=>{
    if(binary)return
    const value=JSON.parse(raw)
    if(value.type!=='session.update')return
    summary.sessions++
    const id=value.client?.anonymous_user_id
    if(/^anon_[a-f0-9]{32}$/.test(id)){summary.identified_sessions++;ids.add(id)}
    summary.distinct_users=ids.size
    const session='native-fixture-'+summary.sessions;sessions.set(session,id);save()
    ws.send(JSON.stringify({type:'session.created',session:{id:session,config:{harness_control_transport:'client_rpc_v1',external_message_protocol:'harness_result_v2'}}}))
  })
})
server.listen(19876,'127.0.0.1',()=>{save();console.log('Local Desktop fixture listening on 19876; records only aggregate verification results')})
