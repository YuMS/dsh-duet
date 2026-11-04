// Adapted from the user-provided DSH v1 desktop character demo.
export class LipSyncFilter {
 constructor(){this.reset();}
 reset(){this.time=0;this.envelope=0;this.voiced=false;this.quietFor=0;this.current='A';this.pending='A';this.pendingFor=0;this.lastSwitch=-1;this.switches=0;this.mix={A:1,I:0,U:0,E:0,O:0};this.weights={A:0,I:0,U:0,E:0,O:0};}
 step(rms,candidate,dt,active=true){dt=Math.max(.001,Math.min(.1,dt));this.time+=dt;
  if(!active){this.voiced=false;this.quietFor=0;}else if(rms>.012){this.voiced=true;this.quietFor=0;}else if(rms<.007){this.quietFor+=dt;if(this.quietFor>.055)this.voiced=false;}
  if(this.voiced&&active){if(candidate!==this.pending){this.pending=candidate;this.pendingFor=0;}else this.pendingFor+=dt;if(this.pending!==this.current&&this.pendingFor>=.07&&this.time-this.lastSwitch>=.20){this.current=this.pending;this.lastSwitch=this.time;this.switches++;}}else{this.pendingFor=0;}
  const target=active&&this.voiced?Math.min(.90,Math.pow(Math.max(0,rms-.008)*5.2,.72)):0;
  const tau=target>this.envelope?.10:.115;this.envelope+=(target-this.envelope)*(1-Math.exp(-dt/tau));if(this.envelope<.001)this.envelope=0;
  for(const k of Object.keys(this.mix)){this.mix[k]+=((k===this.current?1:0)-this.mix[k])*(1-Math.exp(-dt/.095));this.weights[k]=this.mix[k]*this.envelope;}
  return this.weights;
 }
}
