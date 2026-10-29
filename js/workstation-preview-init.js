/* Self-contained, no-login MixForge workstation audition. No paid pipeline or upload calls. */
(() => {
  'use strict';
  const status = message => { const el = document.getElementById('demoStatus'); if(el) el.textContent = message; };
  const rate = 22050;
  const duration = 12;
  let decodeContext;
  function demoBuffers(){
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if(!Ctx) throw Error('Audio preview requires Web Audio support.');
    const context = new Ctx(1,rate*duration,rate);
    const names = ['Drums','Bass','Lead','Guitars (synthetic)','Pad'];
    const buffers = names.map(()=>context.createBuffer(1,rate*duration,rate));
    const channels = buffers.map(buffer=>buffer.getChannelData(0));
    const notes = [220,261.63,329.63,293.66,246.94,196,220,261.63];
    const roots = [110,98,130.81,87.31,110,98,130.81,87.31];
    let seed = 192837;
    const noise = () => { seed=(1664525*seed+1013904223)>>>0; return (seed/4294967296)*2-1; };
    for(let i=0;i<rate*duration;i++){
      const t=i/rate, beat=Math.floor(t/.5), step=Math.floor(t/1.5)%notes.length, beatPhase=t%0.5;
      const kickEnv=Math.exp(-beatPhase*18),snareEnv=Math.exp(-beatPhase*27);
      const kick=Math.sin(2*Math.PI*(63-12*beatPhase)*beatPhase)*kickEnv*.25;
      const snare=beat%2===1 ? noise()*snareEnv*.15 : 0;
      const hat=noise()*Math.exp(-(t%.25)*52)*.035;
      channels[0][i]=kick+snare+hat;
      channels[1][i]=.22*Math.sin(2*Math.PI*roots[Math.floor(t/1.5)%roots.length]*t)*(.4+.6*Math.exp(-beatPhase*8));
      const syllable=t%.75;const env=Math.pow(Math.max(0,1-syllable/.75),1.7);
      const freq=notes[step];
      channels[2][i]=.20*env*(Math.sin(2*Math.PI*freq*t)+.25*Math.sin(4*Math.PI*freq*t));
      const pluck=t%.75;
      const chord=roots[Math.floor(t/1.5)%roots.length];
      channels[3][i]=.17*Math.exp(-pluck*3.5)*(Math.sin(2*Math.PI*chord*2*t)+.22*Math.sin(2*Math.PI*chord*4*t)+.11*Math.sin(2*Math.PI*chord*6*t));
      channels[4][i]=.08*(Math.sin(2*Math.PI*roots[step]*t)+Math.sin(2*Math.PI*roots[step]*1.5*t));
    }
    const original=context.createBuffer(1,rate*duration,rate), out=original.getChannelData(0);
    for(let i=0;i<out.length;i++){let s=0;for(const ch of channels)s+=ch[i];out[i]=Math.max(-1,Math.min(1,s));}
    return {original,stemBuffers:Object.fromEntries(names.map((n,i)=>[n,buffers[i]]))};
  }
  function refresh(){
    const refreshBtn=document.getElementById('mfwsRefresh');
    if(refreshBtn)refreshBtn.click();
    else document.getElementById('mfWorkstationLaunch')?.click();
  }
  function install(){
    try {
      Object.assign(state,demoBuffers());
      status('Example session loaded: five generated sounds, not a real song. Press Play, then try Solo, fades and section EQ.');
    }catch(e){status('Demo audio unavailable: '+(e?.message||'unknown error'));}
    const launch = document.getElementById('mfWorkstationLaunch');
    if(launch) launch.click();
    const reset=document.getElementById('demoReset');
    reset?.addEventListener('click',()=>{Object.assign(state,demoBuffers());refresh();status('Generated example session restored.');});
    const mix=document.getElementById('demoMix');
    const stems=document.getElementById('demoStems');
    const decode=async file=>{
      const Ctx=window.AudioContext||window.webkitAudioContext;
      if(!Ctx)throw Error('Web Audio unavailable.');
      decodeContext ||= new Ctx();
      const arr=await file.arrayBuffer();
      return await decodeContext.decodeAudioData(arr);
    };
    mix?.addEventListener('change',async()=>{
      const file=mix.files?.[0];if(!file)return;
      status('Opening '+file.name+' on this device…');
      try{
        const buffer=await decode(file);
        state.original=buffer;state.stemBuffers={};
        refresh();
        status('Loaded '+file.name+'. One stereo lane is shown; MixForge will not pretend the individual instruments are separated.');
      }catch(e){status('Could not decode audio: '+(e?.message||'unsupported file'));}
    });
    stems?.addEventListener('change',async()=>{
      const files=Array.from(stems.files||[]);if(!files.length)return;
      if(files.length>12){status('Select up to 12 stem files for this test.');return;}
      status('Opening '+files.length+' stem file(s) locally…');
      try{
        const entries=[];
        for(const file of files){const buffer=await decode(file);entries.push([file.name.replace(/\.[^.]+$/,'').slice(0,45),buffer]);}
        const maxDuration=entries[0][1].duration;
        if(entries.some(([,b])=>Math.abs(b.duration-maxDuration)>1))status('Stem lengths differ. Check the stems are aligned before relying on audition timing.');
        else status(files.length+' independent stems ready. Use Solo or Mute to isolate parts; all changes are only in this preview.');
        state.stemBuffers=Object.fromEntries(entries);
        state.original=entries[0][1]; // retained only as a playable fallback; no premaster is rendered here
        refresh();
      }catch(e){status('Could not decode a stem: '+(e?.message||'unsupported file'));}
    });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>setTimeout(install,0),{once:true});
  else setTimeout(install,0);
})();