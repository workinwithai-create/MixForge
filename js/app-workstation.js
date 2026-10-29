/* MixForge workstation beta — isolated preview; does not alter canonical correction/master buffers. */
(() => {
  'use strict';
  const whenReady = () => {
    const hero = document.querySelector('.hero');
    if (!hero || document.getElementById('mfWorkstation')) return;
    const launch = document.createElement('button');
    launch.type = 'button';
    launch.id = 'mfWorkstationLaunch';
    launch.className = 'mf-workstation-launch';
    launch.textContent = 'Open MixForge Workstation · preview';
    hero.appendChild(launch);
    const root = document.createElement('section');
    root.id = 'mfWorkstation';
    root.className = 'mf-workstation';
    root.hidden = true;
    hero.insertAdjacentElement('afterend', root);
    const model = {
      tracks: [], mute: new Set(), solo: new Set(), levels: {},
      selected: 0, startPct: 22, endPct: 69, fadeIn: .14, fadeOut: .14,
      clipDb: -3, eqHz: 2400, eqDb: -2, tool: 'Clip gain',
      splits: [], edits: [], dry: false, playing: false,
      offset: 0, startCtxTime: 0, ctx: null, sources: [], activeNodes: [], outputNodes: {}, raf: null
    };
    const color = ['#d7a977','#929ee0','#9cbba9','#c6989d','#a4b2c0'];
    const dB = value => Math.pow(10, Number(value) / 20);
    const fmt = sec => {
      const n = Math.max(0, Math.floor(sec || 0));
      return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
    };
    function bufferForTrack(track) { return track && track.buffer; }
    function refreshTracks() {
      const stemBuffers = typeof state !== 'undefined' && state.stemBuffers ? state.stemBuffers : {};
      const stems = Object.entries(stemBuffers).filter(([,buf]) => buf && typeof buf.getChannelData === 'function');
      model.tracks = stems.length
        ? stems.map(([name,buffer]) => ({ name, buffer, isStem:true }))
        : (typeof state !== 'undefined' && state.original ? [{ name:'Stereo mix', buffer:state.original, isStem:false }] : []);
      model.selected = Math.min(model.selected, Math.max(0, model.tracks.length-1));
      if(model.tracks.length && model.offset >= model.tracks[0].buffer.duration) model.offset = 0;
    }
    function currentDuration(){ return model.tracks[0]?.buffer?.duration || 0; }
    function peaks(buffer, count=115){
      if(!buffer) return [];
      const data=buffer.getChannelData(0), step=Math.max(1,Math.floor(data.length/count)), each=Math.max(1,Math.floor(step/80));
      const out=[];
      for(let n=0;n<count;n++){let p=0;const begin=n*step;for(let i=begin;i<Math.min(begin+step,data.length);i+=each)p=Math.max(p,Math.abs(data[i]));out.push(Math.min(94,6+Math.sqrt(p)*92));}
      return out;
    }
    function liveTime(){
      if(!model.playing || !model.ctx) return model.offset;
      return Math.min(currentDuration(),model.offset + model.ctx.currentTime - model.startCtxTime);
    }
    function stop(reset=false){
      const v=liveTime();
      model.playing=false;
      for(const src of model.sources) {try{src.onended=null;src.stop();}catch(_){}try{src.disconnect();}catch(_){}}
      for(const node of model.activeNodes){try{node.disconnect()}catch(_){}}
      model.sources=[];model.activeNodes=[];model.outputNodes={};
      if(model.raf)cancelAnimationFrame(model.raf);model.raf=null;
      model.offset=reset?0:v;
      if(root.hidden) return;
      updateTransport();
    }
    function scheduleEnvelope(param,outside,inside,now,offset,start,end,fadeA,fadeB){
      const total=Math.max(.05,end-start);
      const a=Math.min(total*.4,fadeA),b=Math.min(total*.4,fadeB);
      param.cancelScheduledValues(now);
      const initial=offset>=start&&offset<end?inside:outside;
      param.setValueAtTime(initial,now);
      const pts=[[start,outside],[start+a,inside],[end-b,inside],[end,outside]];
      for(const [t,val] of pts)if(t>offset+.001)param.linearRampToValueAtTime(val,now+t-offset);
    }
    function updateAuditionGains(){
      const soloActive=model.solo.size>0;
      for(const track of model.tracks){
        const out=model.outputNodes[track.name];if(!out||!model.ctx)continue;
        const audible=!model.mute.has(track.name)&&(!soloActive||model.solo.has(track.name));
        out.gain.setTargetAtTime(audible?dB(model.levels[track.name]??0):0,model.ctx.currentTime,.012);
      }
    }
    async function play(){
      refreshTracks();
      if(!model.tracks.length){updateNotice('Load a mix using the existing MixForge upload first.');return;}
      if(model.playing){stop();return;}
      if(model.offset>=currentDuration()-.05)model.offset=0;
      try{
        const Ctx=window.AudioContext||window.webkitAudioContext;
        if(!Ctx)throw Error('This browser does not support Web Audio playback.');
        model.ctx=model.ctx||new Ctx();
        await model.ctx.resume();
        const now=model.ctx.currentTime+.04;
        const offset=model.offset;
        const duration=currentDuration();
        const start=model.startPct/100*duration,end=model.endPct/100*duration;
        model.startCtxTime=now;
        const activeSolo=model.solo.size>0;
        model.tracks.forEach((track,i)=>{
          if(!track.buffer)return;
          const src=model.ctx.createBufferSource();
          src.buffer=track.buffer;
          const out=model.ctx.createGain();
          const active=(!model.mute.has(track.name)) && (!activeSolo||model.solo.has(track.name));
          out.gain.value=active?dB(model.levels[track.name]??0):0;
          out.connect(model.ctx.destination);
          model.activeNodes.push(out);model.outputNodes[track.name]=out;
          const isSelected=i===model.selected&&!model.dry;
          if(isSelected){
            const dry=model.ctx.createGain(),wet=model.ctx.createGain();
            const eq=model.ctx.createBiquadFilter();
            eq.type='peaking';eq.frequency.value=model.eqHz;eq.Q.value=1;eq.gain.value=model.tool==='EQ'?model.eqDb:0;
            src.connect(dry);src.connect(eq);eq.connect(wet);dry.connect(out);wet.connect(out);
            model.activeNodes.push(dry,wet,eq);
            scheduleEnvelope(dry.gain,1,0,now,offset,start,end,model.fadeIn,model.fadeOut);
            scheduleEnvelope(wet.gain,0,dB(model.clipDb),now,offset,start,end,model.fadeIn,model.fadeOut);
          }else src.connect(out);
          src.start(now,offset);
          model.sources.push(src);
        });
        if(model.sources.length===0)throw Error('No playable tracks.');
        const last=model.sources[0];
        last.onended=()=>{if(model.playing)stop(true)};
        model.playing=true;model.startCtxTime=now;
        const tick=()=>{
          if(!model.playing)return;
          updateTransport();
          if(liveTime()>=currentDuration()-.05){stop(true);return}
          model.raf=requestAnimationFrame(tick);
        };
        model.raf=requestAnimationFrame(tick);
        updateNotice(model.dry?'Original-level preview; any current mute/solo and faders remain active.':'Edited audition: selected-region gain and fades are audible; EQ is active when EQ is selected.');
        updateTransport();
      }catch(error){stop();updateNotice('Playback unavailable: '+(error?.message||'audio error'));}
    }
    function updateNotice(message){const el=root.querySelector('#mfwsNotice');if(el)el.textContent=message;}
    function updateTransport(){
      const txt=root.querySelector('#mfwsClock');if(txt)txt.textContent=fmt(liveTime())+' / '+fmt(currentDuration());
      const btn=root.querySelector('#mfwsPlay');if(btn)btn.textContent=model.playing?'❚❚ Pause':'▶ Play / audition';
      const line=root.querySelector('#mfwsHead');if(line)line.style.left=(currentDuration()?100*liveTime()/currentDuration():0)+'%';
    }
    function patchContent(){
      refreshTracks();
      const hasAudio=model.tracks.length>0, duration=currentDuration();
      root.innerHTML = '<div class="mfws-top"><div><span>MIXFORGE · THE WORKSTATION</span><h2>Hear the problem. Make the repair.</h2><p>A focused mixing desk that connects to MixForge’s existing forensic pipeline.</p></div><div class="mfws-top-actions"><span class="mfws-beta">PREVIEW · ORIGINALS PRESERVED</span><button id="mfwsClose" type="button">Close ×</button></div></div>'+
        '<nav class="mfws-tabs"><span class="selected">01 / Channel balance</span><span>02 / Section editor</span><span>03 / Repair tools</span><span>04 / Existing master pipeline</span></nav>'+
        '<div class="mfws-heading"><strong>CHANNEL BALANCE</strong><span id="mfwsTrackCount"></span><button id="mfwsRefresh">↻ Refresh stems</button></div>'+
        '<div id="mfwsTracks" class="mfws-tracks"></div>'+
        '<div class="mfws-heading"><strong>SECTION EDITOR</strong><span>SPLIT MARKERS · FADES · CLIP GAIN</span></div>'+
        '<div class="mfws-editbar"><label>Target <select id="mfwsSelected"></select></label><label>Compare <select id="mfwsCompare"><option value="wet">Edited audition</option><option value="dry">Without section edits</option></select></label></div>'+
        '<div class="mfws-timeline"><div class="mfws-ruler"><span>0:00</span><span id="mfwsMid">'+fmt(duration/2)+'</span><span>'+fmt(duration)+'</span></div><div id="mfwsWave" class="mfws-wave"><div id="mfwsRegion" class="mfws-region"><i class="mfws-fade-start"></i><i class="mfws-fade-end"></i></div><div id="mfwsSplits"></div><div id="mfwsHead" class="mfws-playhead"></div></div></div>'+
        '<div class="mfws-range-row"><label>Selection start <input id="mfwsStart" type="range" min="0" max="98" step=".5"><span id="mfwsStartText"></span></label><label>Selection end <input id="mfwsEnd" type="range" min="2" max="100" step=".5"><span id="mfwsEndText"></span></label></div>'+
        '<div class="mfws-tool-row"><button id="mfwsPlay">▶ Play / audition</button><button id="mfwsStop">■ Stop</button><span id="mfwsClock">0:00 / 0:00</span><button id="mfwsSplit">✂ Mark split</button><button id="mfwsFadeIn">◢ Fade in</button><button id="mfwsFadeOut">◣ Fade out</button></div>'+
        '<div class="mfws-heading"><strong>AUDIO REPAIR TOOLS</strong><span>EDIT THE SOUND, THEN VERIFY</span></div>'+
        '<div class="mfws-tools" id="mfwsTools"></div>'+
        '<div class="mfws-controls"><label>Section level <input id="mfwsClip" type="range" min="-24" max="9" step=".5"><b id="mfwsClipTxt"></b></label><label>EQ frequency <input id="mfwsFreq" type="range" min="60" max="12000" step="10"><b id="mfwsFreqTxt"></b></label><label>EQ gain <input id="mfwsEq" type="range" min="-12" max="12" step=".5"><b id="mfwsEqTxt"></b></label></div>'+
        '<div class="mfws-foot"><p id="mfwsNotice" aria-live="polite"></p><button id="mfwsExportNotes">Export edit notes</button><button id="mfwsClear">Reset preview edits</button></div>'+
        '<p class="mfws-truth">These controls audition the existing in-memory MixForge audio without replacing the source, sequential correction, receipts, or mastering results. Solo/mute, levels, section-gain fades and selected-region EQ are playable. Split creates an edit marker; destructive splice, spectral repair and other processors are not implemented in this preview.</p>';
      root.querySelector('#mfwsClose').onclick=()=>{stop();root.hidden=true;launch.textContent='Open MixForge Workstation · preview';};
      root.querySelector('#mfwsRefresh').onclick=()=>{stop();patchContent()};
      const tc=root.querySelector('#mfwsTrackCount');tc.textContent=hasAudio?(model.tracks.length+' '+(model.tracks.length===1?'mix lane':'stem lanes')):'No audio loaded';
      const tracksEl=root.querySelector('#mfwsTracks');
      if(!hasAudio)tracksEl.innerHTML='<div class="mfws-empty">Load a stereo mix above and scan it. Run source investigation to unlock independent stem solo/mute and levels here.</div>';
      model.tracks.forEach((t,i)=>{
        const card=document.createElement('div');card.className='mfws-channel';card.style.setProperty('--channel-color',color[i%color.length]);
        card.innerHTML='<div class="mfws-channel-name"></div><div class="mfws-vertical-meter"><i></i></div><input class="mfws-level" type="range" min="-24" max="9" step=".5" aria-label="Channel gain"><small class="mfws-level-value"></small><div class="mfws-ms"><button class="mute" type="button">M</button><button class="solo" type="button">S</button></div>';
        card.querySelector('.mfws-channel-name').textContent=t.name;
        const slider=card.querySelector('.mfws-level');slider.value=String(model.levels[t.name]??0);
        const out=card.querySelector('.mfws-level-value');
        const renderLevel=()=>{
          out.textContent=(Number(slider.value)>0?'+':'')+slider.value+' dB';
          card.querySelector('.mfws-vertical-meter i').style.height=Math.min(98,Math.max(10,70+Number(slider.value)*2))+'%';
        };renderLevel();
        slider.oninput=()=>{model.levels[t.name]=Number(slider.value);renderLevel();updateAuditionGains()};
        const mute=card.querySelector('.mute'),solo=card.querySelector('.solo');
        const redrawButtons=()=>{mute.classList.toggle('on',model.mute.has(t.name));solo.classList.toggle('on',model.solo.has(t.name));mute.setAttribute('aria-pressed',String(model.mute.has(t.name)));solo.setAttribute('aria-pressed',String(model.solo.has(t.name)));};
        mute.onclick=()=>{model.mute.has(t.name)?model.mute.delete(t.name):model.mute.add(t.name);redrawButtons();updateAuditionGains()};
        solo.onclick=()=>{model.solo.has(t.name)?model.solo.delete(t.name):model.solo.add(t.name);redrawButtons();updateAuditionGains()};
        redrawButtons();tracksEl.appendChild(card);
      });
      const select=root.querySelector('#mfwsSelected');
      model.tracks.forEach((t,i)=>{const opt=document.createElement('option');opt.value=String(i);opt.textContent=t.name;select.appendChild(opt)});
      select.value=String(model.selected);
      select.onchange=()=>{model.selected=Number(select.value);renderWave();if(model.playing)stop()};
      const compare=root.querySelector('#mfwsCompare');compare.value=model.dry?'dry':'wet';
      compare.onchange=()=>{model.dry=compare.value==='dry';if(model.playing)stop()};
      const tools=[['EQ','Time-limited tonal corrections'],['Clip gain','Adjust selected passage'],['Automation','Level and pan envelopes'],['De-esser','Vocal sibilance'],['Cleanup','Clicks, noise, hum'],['Spectral repair','Localized artifacts'],['Masking','Vocal/instrument conflicts'],['Suggested fixes','Existing forensic findings']];
      const toolBox=root.querySelector('#mfwsTools');
      tools.forEach(([tool,desc])=>{
        const b=document.createElement('button');b.type='button';b.innerHTML='<span class="mfws-toolicon">✧</span><b></b><small></small>';
        b.querySelector('b').textContent=tool;b.querySelector('small').textContent=desc;
        if(tool===model.tool)b.classList.add('on');
        b.onclick=()=>{model.tool=tool;toolBox.querySelectorAll('button').forEach(n=>n.classList.remove('on'));b.classList.add('on');if(model.playing)stop();
          updateNotice(['EQ','Clip gain'].includes(tool)?'You can audition this section setting. Other repair modules remain part of the existing forensic workflow.':'This tool is an interface target; use MixForge’s existing Forensic Fix pipeline for its real processing.');
        };
        toolBox.appendChild(b);
      });
      const knob=(id,key,label)=>{const input=root.querySelector(id);input.value=model[key];input.oninput=()=>{model[key]=Number(input.value);root.querySelector(label).textContent=(model[key]>0&&key!=='eqHz'?'+':'')+model[key]+(key==='eqHz'?' Hz':' dB')};input.dispatchEvent(new Event('input'))};
      knob('#mfwsClip','clipDb','#mfwsClipTxt');knob('#mfwsFreq','eqHz','#mfwsFreqTxt');knob('#mfwsEq','eqDb','#mfwsEqTxt');
      const startInput=root.querySelector('#mfwsStart'),endInput=root.querySelector('#mfwsEnd');
      startInput.value=model.startPct;endInput.value=model.endPct;
      startInput.oninput=()=>{model.startPct=Math.min(Number(startInput.value),model.endPct-1);refreshRegion();};
      endInput.oninput=()=>{model.endPct=Math.max(Number(endInput.value),model.startPct+1);refreshRegion();};
      root.querySelector('#mfwsPlay').onclick=play;
      root.querySelector('#mfwsStop').onclick=()=>stop(true);
      root.querySelector('#mfwsSplit').onclick=()=>{const at=(model.startPct+model.endPct)/2;model.splits.push(at);model.edits.push({type:'split-marker',time:at/100*duration});renderWave();updateNotice('Split marker added. Physical audio slicing is not implemented in this preview.')};
      root.querySelector('#mfwsFadeIn').onclick=()=>{model.fadeIn=Math.min(1.5,model.fadeIn+.18);model.edits.push({type:'fade-in',seconds:model.fadeIn});updateNotice('Fade-in audition length: '+model.fadeIn.toFixed(2)+' s.')};
      root.querySelector('#mfwsFadeOut').onclick=()=>{model.fadeOut=Math.min(1.5,model.fadeOut+.18);model.edits.push({type:'fade-out',seconds:model.fadeOut});updateNotice('Fade-out audition length: '+model.fadeOut.toFixed(2)+' s.')};
      root.querySelector('#mfwsClear').onclick=()=>{stop(true);model.splits=[];model.edits=[];model.clipDb=-3;model.eqDb=-2;model.eqHz=2400;model.fadeIn=.14;model.fadeOut=.14;patchContent()};
      root.querySelector('#mfwsExportNotes').onclick=()=>{
        const summary={previewOnly:true,source:'MixForge Workstation',trackNames:model.tracks.map(t=>t.name),muted:[...model.mute],soloed:[...model.solo],levelsDb:model.levels,selected:model.tracks[model.selected]?.name,regionSeconds:{start:model.startPct/100*duration,end:model.endPct/100*duration},clipGainDb:model.clipDb,fadeInSeconds:model.fadeIn,fadeOutSeconds:model.fadeOut,eqHz:model.eqHz,eqDb:model.eqDb,splitMarkers:model.splits.map(p=>p/100*duration),notes:'Non-destructive workstation audition. No repair or master was rendered into canonical MixForge state.'};
        const u=URL.createObjectURL(new Blob([JSON.stringify(summary,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download='mixforge-workstation-edits.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);
      };
      renderWave();updateNotice(hasAudio?(model.tracks.length>1?'Source stems are available: solo/mute, faders, fades and EQ are auditionable.':'Stereo mix loaded. Isolate stems through Forensic Fix to control separate instruments.'):'No mix loaded yet. Load a file using the MixForge upload, then press Refresh stems.');updateTransport();
    }
    function refreshRegion(){
      const dur=currentDuration();
      root.querySelector('#mfwsStartText').textContent=fmt(model.startPct/100*dur);
      root.querySelector('#mfwsEndText').textContent=fmt(model.endPct/100*dur);
      const region=root.querySelector('#mfwsRegion');region.style.left=model.startPct+'%';region.style.width=(model.endPct-model.startPct)+'%';
    }
    function renderWave(){
      const waveEl=root.querySelector('#mfwsWave');if(!waveEl)return;
      waveEl.querySelectorAll('.mfws-peak').forEach(n=>n.remove());
      const p=peaks(bufferForTrack(model.tracks[model.selected]),115);
      for(let i=0;i<p.length;i++){
        const bar=document.createElement('i');bar.className='mfws-peak';bar.style.height=p[i]+'%';
        bar.style.left=(i/p.length*100)+'%';bar.style.width=Math.max(.45,90/p.length)+'%';
        bar.style.background=i/p.length*100>=model.startPct&&i/p.length*100<=model.endPct?'#9cb6e3':'#be9b73';
        waveEl.appendChild(bar);
      }
      const marks=root.querySelector('#mfwsSplits');marks.replaceChildren();
      model.splits.forEach(at=>{const el=document.createElement('i');el.className='mfws-split';el.style.left=at+'%';marks.appendChild(el)});
      refreshRegion();updateTransport();
    }
    launch.onclick=()=>{
      if(!root.hidden){stop();root.hidden=true;launch.textContent='Open MixForge Workstation · preview';return;}
      root.hidden=false;patchContent();root.scrollIntoView({behavior:'smooth',block:'start'});launch.textContent='Close workstation preview';
    };
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',whenReady,{once:true});
  else whenReady();
})();