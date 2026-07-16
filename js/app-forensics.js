'use strict';

// MixForge 2.0 forensic reasoning layer.
// Separates observation, hypothesis, confirmation, repair and verification.

const MF_PROFILE_KEY = 'mixforge.engineerProfile.v2';
const MF_SESSION_KEY = 'mixforge.session.v2';
const forensicState = {
  timeline: [], sourceProfile: [], reconstruction: null, references: [],
  profile: { genre: 'Singer-songwriter / rock', vocalTone: 'Warm, natural, preserve rasp', intensity: 'balanced', priorities: 'Preserve vocal character, guitar body, dynamics and emotional delivery.' },
};

function mfLoadProfile() {
  try { forensicState.profile = { ...forensicState.profile, ...JSON.parse(localStorage.getItem(MF_PROFILE_KEY) || '{}') }; } catch (_) {}
}
function mfSaveProfile() { try { localStorage.setItem(MF_PROFILE_KEY, JSON.stringify(forensicState.profile)); } catch (_) {} }
function mfSaveSession(stage) {
  try {
    localStorage.setItem(MF_SESSION_KEY, JSON.stringify({
      stage, at: Date.now(), file: state.file ? { name: state.file.name, size: state.file.size, modified: state.file.lastModified } : null,
      audit: state.audit, timeline: forensicState.timeline, sourceProfile: forensicState.sourceProfile,
      requestedStems: state.audit?.stemsToInspect || [], profile: forensicState.profile,
    }));
  } catch (_) {}
}

function mfEl(tag, cls, text) { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; }
function mfFmtTime(seconds) { const m = Math.floor(seconds / 60); const s = Math.floor(seconds % 60).toString().padStart(2, '0'); return `${m}:${s}`; }
function mfSeverityScore(severity) { return severity === 'high' ? 3 : severity === 'medium' ? 2 : 1; }
function mfConfidence(value) { return clamp(Math.round(value), 5, 98); }

function mfSliceBuffer(buffer, startSec, endSec) {
  const start = clamp(Math.floor(startSec * buffer.sampleRate), 0, buffer.length - 1);
  const end = clamp(Math.floor(endSec * buffer.sampleRate), start + 1, buffer.length);
  const out = state.audioCtx.createBuffer(buffer.numberOfChannels, end - start, buffer.sampleRate);
  for (let c = 0; c < buffer.numberOfChannels; c++) out.copyToChannel(buffer.getChannelData(c).subarray(start, end), c);
  return out;
}

function mfSectionAnalysis(buffer) {
  const duration = buffer.duration;
  const targetWindow = duration > 360 ? 24 : duration > 180 ? 18 : duration > 90 ? 12 : 8;
  const count = clamp(Math.ceil(duration / targetWindow), 4, 18);
  const sectionLength = duration / count;
  const sections = [];
  for (let i = 0; i < count; i++) {
    const start = i * sectionLength, end = Math.min(duration, (i + 1) * sectionLength);
    const metrics = measureBuffer(mfSliceBuffer(buffer, start, end));
    const lowMid = band(metrics, 'Low-mids') - band(metrics, 'Mids');
    const masking = band(metrics, 'Low-mids') - band(metrics, 'Presence');
    const sideMud = band(metrics, 'Low-mids', true) - band(metrics, 'Mids', true);
    const flare = metrics.sibilance.p95Db - metrics.sibilance.medianDb;
    const risks = [];
    if (lowMid > 7) risks.push({ key: 'lowMid', label: 'Low-mid congestion', score: lowMid });
    if (masking > 14) risks.push({ key: 'masking', label: 'Lead-band masking', score: masking });
    if (sideMud > 8) risks.push({ key: 'width', label: 'Wide low-mid smear', score: sideMud });
    if (flare > 8 && metrics.sibilance.flares > metrics.sibilance.frames * .05) risks.push({ key: 'flare', label: 'HF flares', score: flare });
    if (metrics.correlation < .12) risks.push({ key: 'phase', label: 'Mono risk', score: (0.12 - metrics.correlation) * 40 });
    sections.push({ start, end, metrics: { lufs: metrics.lufs, crestDb: metrics.crestDb, correlation: metrics.correlation }, risks });
  }
  return sections;
}

function mfSourceProfile(metrics, notes = '') {
  const lowMid = band(metrics, 'Low-mids'), mids = band(metrics, 'Mids'), presence = band(metrics, 'Presence'), air = band(metrics, 'Air');
  const text = notes.toLowerCase();
  const vocal = mfConfidence(58 + clamp((lowMid - presence) * 1.3, -15, 26) + (/(vocal|voice|sing|lyric)/.test(text) ? 18 : 0));
  const guitars = mfConfidence(48 + clamp((band(metrics, 'Low-mids', true) - band(metrics, 'Mids', true)) * 2, -12, 28) + (/(guitar|acoustic|electric)/.test(text) ? 18 : 0));
  const bass = mfConfidence(52 + clamp((band(metrics, 'Sub') - band(metrics, 'Bass') + 4) * 3, -12, 25));
  const drums = mfConfidence(45 + clamp(metrics.crestDb - 9, -8, 25));
  const keys = mfConfidence(28 + clamp((mids - presence + 8), -8, 22) + (/(piano|keys|synth)/.test(text) ? 25 : 0));
  const ambience = mfConfidence(40 + clamp(metrics.widthDb + 12, -15, 25));
  return [
    ['Lead vocal', vocal, vocal > 70 ? 'likely present' : 'possible'], ['Guitar-family content', guitars, guitars > 70 ? 'likely present' : 'possible'],
    ['Bass', bass, bass > 68 ? 'likely present' : 'possible'], ['Drums / percussion', drums, drums > 65 ? 'likely present' : 'uncertain'],
    ['Keys / pads', keys, keys > 65 ? 'likely present' : 'uncertain'], ['Stereo ambience', ambience, ambience > 65 ? 'present' : 'limited / uncertain'],
  ].map(([source, confidence, status]) => ({ source, confidence, status }));
}

function mfForensicAudit(metrics, notes, targetLufs) {
  const findings = [];
  const add = (severity, problem, evidence, consequence, candidates, nextTest, confidence) => findings.push({
    severity, stage: 'mix', problem, evidence, consequence, candidates, nextTest, confidence: mfConfidence(confidence), action: `Investigation: ${nextTest}`, stem: null,
  });
  if (metrics.clipPercent > .001 || metrics.peakDb > -.1) add('high', 'Source overload detected', `${metrics.clipPercent.toFixed(3)}% clipped frames; sample peak ${metrics.peakDb.toFixed(2)} dBFS.`, 'Distortion and reduced mastering headroom.', [], 'Obtain a clean pre-limiter bounce before repair.', 96);
  if (Math.abs(metrics.dcOffset) > .003) add('medium', 'Meaningful DC offset', `Average waveform offset ${(metrics.dcOffset * 100).toFixed(2)}%.`, 'Asymmetric headroom and possible edit clicks.', [], 'Apply DC removal before dynamics processing.', 98);
  const lowMid = band(metrics, 'Low-mids') - band(metrics, 'Mids');
  if (lowMid > 7) add('medium', 'Center low-mid congestion', `Center 250–500 Hz is ${lowMid.toFixed(1)} dB above the mid band.`, 'Reduced separation and perceived clarity.', [{ stem:'vocals', likelihood: mfConfidence(48 + lowMid*2) }, { stem:'guitars', likelihood: mfConfidence(52 + lowMid*1.7) }, { stem:'keys', likelihood: mfConfidence(25 + lowMid) }, { stem:'bass', likelihood: mfConfidence(18 + lowMid) }], 'Separate vocals and guitars first; add keys or bass only if the first test is inconclusive.', 86);
  const masking = band(metrics, 'Low-mids') - band(metrics, 'Presence');
  if (masking > 14) add('medium', 'Lead-band masking condition', `Center presence is ${masking.toFixed(1)} dB below dominant low-mids.`, 'Lyrics or lead articulation may recede on small speakers.', [{ stem:'vocals', likelihood: mfConfidence(55 + masking) }, { stem:'guitars', likelihood: mfConfidence(45 + masking*.9) }, { stem:'keys', likelihood: mfConfidence(24 + masking*.5) }], 'Measure vocal intelligibility against guitar/keys occupancy after isolation.', 83);
  const sideMud = band(metrics, 'Low-mids', true) - band(metrics, 'Mids', true);
  if (sideMud > 8) add('medium', 'Wide low-mid accumulation', `Side-channel low-mids are ${sideMud.toFixed(1)} dB above side mids.`, 'The mix may feel wide but indistinct.', [{ stem:'guitars', likelihood: mfConfidence(58 + sideMud*2) }, { stem:'keys', likelihood: mfConfidence(31 + sideMud) }, { stem:'other', likelihood: mfConfidence(26 + sideMud) }], 'Isolate guitar-family and ambience content; confirm with reconstruction-safe comparison.', 81);
  const flare = metrics.sibilance.p95Db - metrics.sibilance.medianDb;
  if (flare > 7 && metrics.sibilance.flares > metrics.sibilance.frames*.05) add('medium', 'Intermittent high-frequency flares', `${metrics.sibilance.flares} events rise ${flare.toFixed(1)} dB above the normal top-end envelope.`, 'Sibilance, pick attack or cymbals may become fatiguing.', [{ stem:'vocals', likelihood: mfConfidence(50 + flare*2) }, { stem:'guitars', likelihood: mfConfidence(30 + flare*1.5) }, { stem:'drums', likelihood: mfConfidence(35 + flare) }], 'Separate likely contributors and identify which stem contains the events before applying dynamic control.', 78);
  if (metrics.correlation < .15) add('high', 'Mono compatibility risk', `Stereo correlation is ${metrics.correlation.toFixed(2)}.`, 'Important elements may cancel in mono.', [{ stem:'guitars', likelihood: 70 }, { stem:'other', likelihood: 64 }, { stem:'keys', likelihood: 48 }], 'Run stem polarity and reconstruction checks before any width processing.', 91);
  if (metrics.crestDb < 8) add('high', 'Dynamics already over-controlled', `Crest factor is ${metrics.crestDb.toFixed(1)} dB.`, 'Additional compression may reduce punch and emotional movement.', [], 'Skip mastering compression and request a less-limited bounce when possible.', 94);
  if (metrics.lra > 15) findings.push({ severity:'low', stage:'master', problem:'Very wide macro-dynamics', evidence:`Approximate loudness range ${metrics.lra.toFixed(1)} LU.`, consequence:'Section-to-section translation may vary.', candidates:[], nextTest:'Inspect section loudness before deciding between automation and compression.', confidence:82, action:'Inspect section loudness; do not compress globally by default.', stem:null });
  const stems = [];
  findings.forEach(f => (f.candidates || []).forEach(c => { if (c.likelihood >= 62 && !stems.includes(c.stem)) stems.push(c.stem); }));
  const priority = ['vocals','guitars','bass','drums','keys','other'];
  const stemsToInspect = priority.filter(s => stems.includes(s)).slice(0, 3);
  const penalty = findings.reduce((sum,f) => sum + mfSeverityScore(f.severity)*6, 0);
  return {
    readinessScore: clamp(Math.round(96 - penalty), 18, 98),
    summary: findings.length ? `${findings.length} measured condition${findings.length===1?'':'s'} require investigation. Source assignments below are hypotheses until isolated stems confirm them.` : 'No major corrective conditions were detected. Proceed to conservative mastering and final verification.',
    findings, stemsToInspect, targetLufs, notes,
  };
}

fallbackMixAudit = mfForensicAudit;

function mfEnsureForensicUI() {
  if ($('forensicProfile')) return;
  const panel = $('loadPanel');
  const box = mfEl('div','forensic-setup'); box.id='forensicProfile';
  box.innerHTML = `<h3>Engineer context</h3><div class="controls-grid"><label>Genre / production style<input id="mfGenre" value=""></label><label>Repair intensity<select id="mfIntensity"><option value="preserve">Preserve</option><option value="balanced">Balanced</option><option value="assertive">Assertive</option></select></label></div><label class="field-label">Mix priorities</label><textarea id="mfPriorities"></textarea><label class="field-label">Reference track <em>optional</em></label><input id="mfReference" type="file" accept="audio/*,.wav,.mp3,.m4a,.aif,.aiff">`;
  panel.insertBefore(box, panel.querySelector('.actions'));
  $('mfGenre').value=forensicState.profile.genre; $('mfIntensity').value=forensicState.profile.intensity; $('mfPriorities').value=forensicState.profile.priorities;
  ['mfGenre','mfIntensity','mfPriorities'].forEach(id => $(id).addEventListener('change',()=>{ forensicState.profile.genre=$('mfGenre').value; forensicState.profile.intensity=$('mfIntensity').value; forensicState.profile.priorities=$('mfPriorities').value; mfSaveProfile(); }));
  $('mfReference').addEventListener('change', async e => { const f=e.target.files?.[0]; if(!f)return; try { setStatus('auditStatus','Reading and level-matching reference…','busy'); const b=await decodeAudioDataSafe(await ensureAudioContext(false), await readFileBytes(f)); forensicState.references=[{name:f.name,metrics:measureBuffer(b)}]; setStatus('auditStatus',`Reference ready: ${f.name}`,'ok'); } catch(err){ setStatus('auditStatus',`Reference could not be read: ${err.message}`,'error'); } });
}

function mfRenderForensicAudit(audit, metrics) {
  $('readinessScore').textContent=Math.round(audit.readinessScore); $('auditSummary').textContent=audit.summary; renderMetrics('mixMetrics',metrics);
  forensicState.timeline=mfSectionAnalysis(state.original); forensicState.sourceProfile=mfSourceProfile(metrics,$('notes').value);
  const root=$('auditFindings'); root.replaceChildren();
  const profile=mfEl('section','forensic-block'); profile.innerHTML='<h3>Source profile <small>presence estimates, not isolated stems</small></h3>';
  const pg=mfEl('div','source-grid'); forensicState.sourceProfile.forEach(x=>{ const c=mfEl('div','source-card'); c.innerHTML=`<b>${x.source}</b><span>${x.status}</span><i>${x.confidence}% confidence</i>`; pg.append(c); }); profile.append(pg); root.append(profile);
  const timeline=mfEl('section','forensic-block'); timeline.innerHTML='<h3>Section-aware risk timeline</h3>';
  const lane=mfEl('div','risk-timeline'); forensicState.timeline.forEach(s=>{ const seg=mfEl('div',`risk-segment ${s.risks.length?'flagged':''}`); seg.style.flex=`${Math.max(.5,s.end-s.start)}`; seg.title=s.risks.length?s.risks.map(r=>r.label).join(', '):'No major condition'; seg.innerHTML=`<b>${mfFmtTime(s.start)}</b><span>${s.risks.length?s.risks.length:'✓'}</span>`; lane.append(seg); }); timeline.append(lane); root.append(timeline);
  const heading=mfEl('h3','forensic-heading','Measured conditions'); root.append(heading);
  audit.findings.forEach(f=>{ const card=mfEl('article',`finding ${f.severity}`); const top=mfEl('div','finding-top'); top.append(mfEl('h3','',f.problem),mfEl('span','badge',`${f.stage} · ${f.confidence}% confidence`)); card.append(top,mfEl('p','',f.evidence),mfEl('p','consequence',`Audible consequence: ${f.consequence||'Translation risk.'}`)); if(f.candidates?.length){ const list=mfEl('div','hypothesis-list'); list.append(mfEl('b','','Source hypotheses — not confirmed')); f.candidates.sort((a,b)=>b.likelihood-a.likelihood).forEach(c=>list.append(mfEl('span','',`${c.stem}: ${c.likelihood}% likely`))); card.append(list); } card.append(mfEl('p','action',`Next test: ${f.nextTest||f.action}`)); root.append(card); });
  if(forensicState.references.length){ const r=forensicState.references[0], diff=metrics.lufs-r.metrics.lufs; const ref=mfEl('section','forensic-block'); ref.innerHTML=`<h3>Level-matched reference context</h3><p>${r.name}: tonal and dynamic comparison is interpreted as a range, not a match-EQ target. Raw loudness difference ${diff>=0?'+':''}${diff.toFixed(1)} LU before level matching.</p>`; root.append(ref); }
  if(audit.stemsToInspect.length){ reveal('separateActions'); $('stemListLabel').textContent=`Investigation: ${audit.stemsToInspect.join(', ')} · attribution pending`; } else { hide('separateActions'); state.corrected=state.original; prepareMastering(); }
  mfSaveSession('audit');
}
renderAudit = mfRenderForensicAudit;

function mfStemQuality(stem, metrics, mixMetrics) {
  const levelGap=Math.abs(metrics.lufs-mixMetrics.lufs); const widthPenalty=Math.max(0,Math.abs(metrics.widthDb)-18); const phasePenalty=Math.max(0,.15-metrics.correlation)*55;
  const score=clamp(Math.round(96-levelGap*.45-widthPenalty-phasePenalty),35,97);
  return { score, risk:score>=82?'low':score>=65?'moderate':'high', guidance:score>=82?'Safe for conservative corrective processing.':score>=65?'Use only broad, low-intensity correction; leakage may be present.':'Do not use aggressive processing. Prefer mix-bus correction or another separation strategy.' };
}

const mfOriginalBuildStemPlans=buildStemPlans;
buildStemPlans=async function(){
  await mfOriginalBuildStemPlans();
  for(const [stem,plan] of Object.entries(state.stemPlans)){
    plan.quality=mfStemQuality(stem,plan.metrics,state.mixMetrics);
    plan.confirmed=[];
    const m=plan.metrics, lowMid=band(m,'Low-mids')-band(m,'Mids'), mask=band(m,'Low-mids')-band(m,'Presence'), flare=m.sibilance.p95Db-m.sibilance.medianDb;
    if(lowMid>7) plan.confirmed.push({condition:'Low-mid buildup',evidence:`${lowMid.toFixed(1)} dB above mids`,confidence:mfConfidence(60+lowMid*2)});
    if(mask>14) plan.confirmed.push({condition:'Presence masking',evidence:`${mask.toFixed(1)} dB low-mid/presence gap`,confidence:mfConfidence(55+mask)});
    if(flare>8&&m.sibilance.flares>m.sibilance.frames*.05) plan.confirmed.push({condition:'High-frequency events',evidence:`${m.sibilance.flares} flares, ${flare.toFixed(1)} dB excursion`,confidence:82});
    const originalOps=plan.operations;
    const safeFactor=plan.quality.score>=82?1:plan.quality.score>=65?.65:.35;
    plan.candidates=[
      {name:'Preserve',wet:.16,operations:originalOps.map(op=>({...op,gain:op.gain!=null?clamp(op.gain*safeFactor*.65,-2.5,1.8):op.gain,ratio:op.ratio?clamp(op.ratio,1,2.2):op.ratio}))},
      {name:'Balanced',wet:.28,operations:originalOps.map(op=>({...op,gain:op.gain!=null?clamp(op.gain*safeFactor,-4,2.5):op.gain,ratio:op.ratio?clamp(op.ratio,1,3):op.ratio}))},
      {name:'Assertive',wet:.40,operations:originalOps.map(op=>({...op,gain:op.gain!=null?clamp(op.gain*safeFactor*1.2,-5,3):op.gain,ratio:op.ratio?clamp(op.ratio,1,3.5):op.ratio}))},
    ];
    const chosen=forensicState.profile.intensity==='preserve'?0:forensicState.profile.intensity==='assertive'?2:1;
    plan.selectedCandidate=chosen; plan.operations=plan.candidates[chosen].operations; plan.wet=plan.candidates[chosen].wet;
  }
  mfSaveSession('stems');
};

renderStemPlans=function(){
  const root=$('stemGrid'); root.replaceChildren();
  for(const [stem,plan] of Object.entries(state.stemPlans)){
    const card=mfEl('article','stem-card forensic-stem'); const head=mfEl('div','stem-head'); head.append(mfEl('h3','',stem),mfEl('span',`badge quality-${plan.quality.risk}`,`Extraction ${plan.quality.score}%`)); card.append(head,mfEl('p','stem-guidance',plan.quality.guidance));
    const confirms=mfEl('div','confirmation-list'); confirms.append(mfEl('b','','Confirmed stem evidence')); if(plan.confirmed.length)plan.confirmed.forEach(x=>confirms.append(mfEl('span','',`${x.condition}: ${x.evidence} · ${x.confidence}%`))); else confirms.append(mfEl('span','healthy','No strong defect confirmed; leave this stem substantially unchanged.')); card.append(confirms);
    const choices=mfEl('div','candidate-choices'); plan.candidates.forEach((c,i)=>{ const b=mfEl('button',i===plan.selectedCandidate?'selected':'',c.name); b.type='button'; b.onclick=()=>{plan.selectedCandidate=i;plan.operations=c.operations;plan.wet=c.wet;renderStemPlans();};choices.append(b);}); card.append(choices);
    const list=mfEl('div','repair-list'); plan.operations.forEach(op=>{const row=mfEl('div','repair');row.append(mfEl('span','',op.label||op.type),mfEl('span','',describeOperation(op)));list.append(row);});card.append(list);
    const note=mfEl('small','guardrail',`Guardrails: level matched · wet ${Math.round(plan.wet*100)}% · static EQ limited · original stem immutable`); card.append(note); root.append(card);
  }
};

rebuildCorrectedMix=async function(){
  const out=cloneBuffer(state.original);
  for(const [stem,rawStem] of Object.entries(state.stemBuffers)){
    const plan=state.stemPlans[stem]; if(!plan)continue; const processed=await renderProcessedBuffer(rawStem,plan.operations); const rawRms=bufferRms(rawStem), fixedRms=bufferRms(processed), match=fixedRms>1e-8?clamp(rawRms/fixedRms,dbToGain(-2),dbToGain(2)):1; const wet=clamp(plan.wet||.2,.08,.45); const length=Math.min(out.length,rawStem.length,processed.length);
    for(let c=0;c<out.numberOfChannels;c++){const dest=out.getChannelData(c),raw=rawStem.getChannelData(Math.min(c,rawStem.numberOfChannels-1)),fixed=processed.getChannelData(Math.min(c,processed.numberOfChannels-1));for(let i=0;i<length;i++)dest[i]+=(fixed[i]*match-raw[i])*wet;}
    await sleep(0);
  }
  const before=measureBuffer(state.original),after=measureBuffer(out); forensicState.reconstruction={peakShift:after.peakDb-before.peakDb,lufsShift:after.lufs-before.lufs,widthShift:after.widthDb-before.widthDb,correlationShift:after.correlation-before.correlation};
  return out;
};

function mfEstimateTruePeak(buffer){let peak=0;for(let c=0;c<buffer.numberOfChannels;c++){const d=buffer.getChannelData(c),step=Math.max(1,Math.floor(d.length/1200000));for(let i=0;i<d.length-step;i+=step){const a=d[i],b=d[i+step];peak=Math.max(peak,Math.abs(a),Math.abs(b),Math.abs(a+(b-a)*.25),Math.abs(a+(b-a)*.5),Math.abs(a+(b-a)*.75));}}return gainToDb(peak);}
function mfTranslationChecks(metrics){return [
  {label:'Phone / laptop intelligibility',ok:band(metrics,'Presence')>band(metrics,'Low-mids')-22,detail:'Lead-band energy remains available on bandwidth-limited playback.'},
  {label:'Mono fold-down',ok:metrics.correlation>=0,detail:`Correlation ${metrics.correlation.toFixed(2)}.`},
  {label:'Low-volume dynamics',ok:metrics.crestDb>=6,detail:`Crest factor ${metrics.crestDb.toFixed(1)} dB.`},
  {label:'Sub-heavy playback',ok:band(metrics,'Sub')<band(metrics,'Bass')+5,detail:'Sub energy is not disproportionately above bass.'},
];}
const mfOldVerification=renderVerification;
renderVerification=function(metrics,plan){
  mfOldVerification(metrics,plan); const root=$('verificationList'); const tp=mfEstimateTruePeak(state.master); const trueRow=mfEl('div',`check ${tp<=-.8?'':'warn'}`); trueRow.innerHTML=`<b>${tp<=-.8?'✓':'!'}</b><div><strong>Estimated true peak: </strong>${tp.toFixed(2)} dBTP</div>`; root.append(trueRow);
  mfTranslationChecks(metrics).forEach(x=>{const row=mfEl('div',`check ${x.ok?'':'warn'}`);row.innerHTML=`<b>${x.ok?'✓':'!'}</b><div><strong>${x.label}: </strong>${x.detail}</div>`;root.append(row);});
  if(forensicState.reconstruction){const r=forensicState.reconstruction,row=mfEl('div',`check ${Math.abs(r.lufsShift)<1.2&&Math.abs(r.widthShift)<3?'':'warn'}`);row.innerHTML=`<b>${Math.abs(r.lufsShift)<1.2?'✓':'!'}</b><div><strong>Repair regression check: </strong>Δ loudness ${r.lufsShift.toFixed(2)} LU, Δ width ${r.widthShift.toFixed(2)} dB, Δ correlation ${r.correlationShift.toFixed(2)}.</div>`;root.append(row);}
  mfSaveSession('verified');
};

mfLoadProfile();
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mfEnsureForensicUI);else mfEnsureForensicUI();
