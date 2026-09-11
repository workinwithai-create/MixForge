import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { validateSemanticRequest, validateSemanticResponse } from '../api/semantic-separation.js';

class FakeBuffer { constructor(channels,length,sampleRate){this.numberOfChannels=channels;this.length=length;this.sampleRate=sampleRate;this.duration=length/sampleRate;this.data=Array.from({length:channels},()=>new Float32Array(length));} getChannelData(channel){return this.data[channel];} }
const context=vm.createContext({console,Math,Number,Object,Array,Set,Promise,Infinity,Float32Array,Float64Array,URLSearchParams,setTimeout,clearTimeout,globalThis:{},document:undefined});
vm.runInContext(fs.readFileSync(new URL('../js/app-timeline-analysis.js',import.meta.url),'utf8'),context);
vm.runInContext(fs.readFileSync(new URL('../js/app-semantic-separation.js',import.meta.url),'utf8'),context);
context.marker={type:'harshness_band',start:14,end:16};
const hypotheses=vm.runInContext('mfSemanticBuildHypotheses(marker)',context);
assert.ok(hypotheses.length>=2);
assert.ok(hypotheses.every(item=>/^Possible /.test(item.label)),'source candidates must remain possibilities');
const bounds=vm.runInContext('mfSemanticExcerptBounds(marker,240)',context);
assert.ok(bounds.duration<=12,'diagnosis must never request a whole song');
const rate=8000,length=rate*4,source=new FakeBuffer(2,length,rate),target=new FakeBuffer(2,length,rate),residual=new FakeBuffer(2,length,rate);
for(let i=0;i<length;i++){const time=i/rate,low=Math.sin(2*Math.PI*45*time)*.22,high=Math.sin(2*Math.PI*900*time)*.18;target.data[0][i]=low;target.data[1][i]=low;residual.data[0][i]=high;residual.data[1][i]=high;source.data[0][i]=low+high;source.data[1][i]=low+high;}
Object.assign(context,{source,target,residual});
const confirmed=vm.runInContext("mfSemanticEvaluateSeparation(source,target,residual,'sub_bass_heavy')",context);
assert.equal(confirmed.sourceConfirmed,true);
assert.equal(confirmed.repairAllowed,true,'source-aware repair unlocks only after confirmation');
const badTarget=new FakeBuffer(1,length,rate);Object.assign(context,{badTarget});
const rejected=vm.runInContext("mfSemanticEvaluateSeparation(source,badTarget,residual,'sub_bass_heavy')",context);
assert.equal(rejected.sourceConfirmed,false,'mono-collapse response must be rejected');
assert.equal(rejected.repairAllowed,false);
context.spotChecks=[{sourceConfirmed:true,hypothesis:hypotheses[0]},{sourceConfirmed:true,hypothesis:hypotheses[0]}];context.hypothesis=hypotheses[0];
const renderPlan=vm.runInContext('mfSemanticBuildVerifiedRenderPlan(spotChecks,hypothesis)',context);
assert.equal(renderPlan.status,'eligible_for_review');assert.equal(renderPlan.enabled,false,'full-song sync render remains disabled');
const validAudio={mimeType:'audio/wav',channels:2,durationSec:4,sampleRate:48000,data:'QUJDRA=='};
assert.equal(validateSemanticRequest({prompt:'lead vocal',markerType:'sibilance',excerpt:validAudio}).excerpt.channels,2);
assert.throws(()=>validateSemanticRequest({prompt:'lead vocal',excerpt:{...validAudio,channels:1}}),/preserve stereo/);
assert.throws(()=>validateSemanticRequest({prompt:'lead vocal',excerpt:{...validAudio,durationSec:120}}),/12 seconds/);
assert.throws(()=>validateSemanticResponse({target:{...validAudio,channels:1},residual:validAudio}),/stereo WAV/);
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');assert.match(html,/id="semanticDiagnosis"/);assert.ok(html.indexOf('app-semantic-separation.js')>html.indexOf('app-targeted-repair-guard.js'));
console.log('MixForge semantic separation smoke tests passed');
