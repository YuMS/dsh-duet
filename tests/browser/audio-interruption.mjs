import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chromium} from 'playwright'

const browser = await chromium.launch({headless:true,args:['--no-sandbox']})
try {
  const page = await browser.newPage()
  await page.route('http://127.0.0.1:19361/**', async route => {
    const name = new URL(route.request().url()).pathname.slice(1)
    if (['audio.mjs','microphone.mjs'].includes(name)) return route.fulfill({contentType:'text/javascript',
      body:await readFile(new URL('../../src/client/'+name,import.meta.url),'utf8')})
    return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Isolated PCM test</title>'})
  })
  await page.goto('http://127.0.0.1:19361/')
  for (const fallback of [false,true]) {
    const result = await page.evaluate(async fallback => {
      const {DuetAudio,AUDIO_STOP_PROTOCOL}=await import('/audio.mjs')
      const audio = new DuetAudio(),events=[]
      const ctx = new OfflineAudioContext(1,32000,16000);audio.context=ctx
      const pcm = new Int16Array(16000).fill(8000)
      const delta = btoa(String.fromCharCode(...new Uint8Array(pcm.buffer)))
      const send=e=>events.push({...e,at:ctx.currentTime})
      audio.event({type:'response.output_audio.delta',response_id:'r',generation:1,sample_rate:16000,delta},send)
      const paused=ctx.suspend(.25), rendered=ctx.startRendering()
      await paused
      const receivedAt=ctx.currentTime
      audio.event({type:'output_audio_buffer.clear',response_id:'r',generation:1,
        audio_stop_protocol:AUDIO_STOP_PROTOCOL,stop_candidates_samples:fallback?[160,320,480]:[1600,4800,8000],
        max_wait_ms:300,fade_ms:12},send)
      const earlyAck=events.some(e=>e.type==='output_audio_buffer.cleared')
      await ctx.resume()
      const data=(await rendered).getChannelData(0)
      // onended is an event task, not a rendering-thread callback.
      await new Promise(resolve=>setTimeout(resolve,30))
      let last=-1
      for(let i=0;i<data.length;i++)if(Math.abs(data[i])>1e-7)last=i
      return {events,earlyAck,receivedAt,last}
    },fallback)
    assert.equal(result.earlyAck,false)
    const acks=result.events.filter(e=>e.type==='output_audio_buffer.cleared')
    assert.equal(acks.length,1)
    assert.equal(acks[0].stop_reason,fallback?'immediate_fallback':'candidate')
    assert.ok(result.last/16000-result.receivedAt<=.301)
    if(!fallback){assert.equal(acks[0].played_samples,4800);assert.equal(acks[0].selected_stop_sample,4800);assert.ok(Math.abs(result.last-5440)<=2)}
    else assert.ok(result.last/16000-result.receivedAt<=.013)
  }
  const boundary = await page.evaluate(async () => {
    const {DuetAudio,AUDIO_STOP_PROTOCOL}=await import('/audio.mjs')
    const audio=new DuetAudio(),ctx=new OfflineAudioContext(1,24000,16000),events=[]
    audio.context=ctx
    const delta=btoa(String.fromCharCode(...new Uint8Array(new Int16Array(8000).fill(8000).buffer)))
    const send=e=>events.push(e)
    for(let i=0;i<2;i++)audio.event({type:'response.output_audio.delta',response_id:'r',generation:1,sample_rate:16000,delta},send)
    const paused=ctx.suspend(.49),rendered=ctx.startRendering()
    await paused
    audio.event({type:'output_audio_buffer.clear',response_id:'r',generation:1,
      audio_stop_protocol:AUDIO_STOP_PROTOCOL,stop_candidates_samples:[8080],max_wait_ms:300,fade_ms:12},send)
    await ctx.resume();const pcm=(await rendered).getChannelData(0)
    await new Promise(resolve=>setTimeout(resolve,30))
    return {before:pcm[8639],after:pcm[8640],silence:pcm[8730],events}
  })
  assert.ok(boundary.before>0 && boundary.after>0)
  assert.ok(Math.abs(boundary.before-boundary.after)<.003,'fade must remain continuous across PCM packet boundary')
  assert.equal(boundary.silence,0)
  assert.equal(boundary.events.filter(e=>e.type==='output_audio_buffer.cleared').at(-1).played_samples,8080)
  console.log('Actual Web Audio render: candidate cut, 12ms fallback, bounded PCM and post-stop acknowledgement passed')
} finally {await browser.close()}
