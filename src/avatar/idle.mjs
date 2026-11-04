// Adapted from the user-provided DSH v1 desktop character demo.
export function rng(seed=6281){let s=seed>>>0;return()=>{s+=0x6D2B79F5;let t=Math.imul(s^(s>>>15),1|s);t^=t+Math.imul(t^(t>>>7),61|t);return((t^(t>>>14))>>>0)/4294967296;};}
const smooth=x=>{x=Math.max(0,Math.min(1,x));return x*x*(3-2*x);};
export class IdleDirector{
 constructor(seed=Date.now()){this.seed=seed;this.rand=rng(seed);this.poses=[{t:0,d:0,p:[0,0,0,0]}];this.blinks=[];this.extend(300);}
 extend(until){const r=this.rand;let last=this.poses.at(-1);while(last.t+last.d<until){const neutral=r()<.20;const next={t:last.t+last.d+2.0+r()*3.5,d:.9+r()*1.5,p:neutral?[0,0,0,0]:[(r()-.5)*.11,(r()-.5)*.24,(r()-.5)*.10,(r()-.5)*1.3]};this.poses.push(next);last=next;}let t=this.blinks.at(-1)?.end??1.5;while(t<until){t+=3.1+r()*4.8;let d=.15+r()*.09;this.blinks.push({t,d,end:t+d});if(r()<.13){t+=d+.12;d=.16;this.blinks.push({t,d,end:t+d});}}}
 sample(t){if(t>this.poses.at(-1).t-20)this.extend(t+180);let i=this.poses.findLastIndex(p=>p.t<=t);if(i<0)i=0;const a=this.poses[Math.max(0,i-1)],b=this.poses[i],f=smooth((t-b.t)/Math.max(.001,b.d)),p=b.p.map((v,k)=>a.p[k]+(v-a.p[k])*f);let blink=0;const ev=this.blinks.find(b=>t>=b.t&&t<=b.end);if(ev){const q=(t-ev.t)/ev.d;blink=q<.40?smooth(q/.40):1-smooth((q-.40)/.60);}const breath=Math.sin(t*1.38+.27*Math.sin(t*.13));return {nod:p[0]+.004*Math.sin(t*.79),yaw:p[1],roll:p[2]+.004*Math.sin(t*.53+1),gaze:p[3]+.08*Math.sin(t*.33),blink,breath,smile:.08+.025*Math.sin(t*.18)};}
}
export class Spring{constructor(w=8,z=.67){this.w=w;this.z=z;this.x=0;this.v=0;}step(target,dt){let n=Math.max(1,Math.ceil(dt/.008));dt/=n;for(let j=0;j<n;j++){this.v+=(this.w*this.w*(target-this.x)-2*this.z*this.w*this.v)*dt;this.x+=this.v*dt;}return this.x;}}
