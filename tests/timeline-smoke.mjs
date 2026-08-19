import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

class FakeBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.data = Array.from({ length: channels }, () => new Float32Array(length));
  }
  getChannelData(channel) { return this.data[channel]; }
}

const context = vm.createContext({
  console,
  Math,
  Number,
  Object,
  Array,
  Set,
  Promise,
  Float32Array,
  Float64Array,
  setTimeout,
  clearTimeout,
});

vm.runInContext(fs.readFileSync(new URL('../js/app-timeline-analysis.js', import.meta.url), 'utf8'), context);

const sampleRate = 12000;
const duration = 8;
const damaged = new FakeBuffer(2, sampleRate * duration, sampleRate);
for (let index = 0; index < damaged.length; index++) {
  const time = index / sampleRate;
  let left = Math.sin(2 * Math.PI * 440 * time) * 0.18;
  let right = left;
  if (time >= 2 && time < 4) {
    left = Math.sin(2 * Math.PI * 3500 * time) * 0.42;
    right = -left;
  } else if (time >= 4 && time < 6) {
    left = Math.sin(2 * Math.PI * 40 * time) * 0.75;
    right = left;
  } else if (time >= 6) {
    left = Math.sin(2 * Math.PI * 900 * time) >= 0 ? 1 : -1;
    right = left;
  }
  damaged.data[0][index] = left;
  damaged.data[1][index] = right;
}
context.damaged = damaged;
const damagedAnalysis = await vm.runInContext('mfTimelineAnalyze(damaged)', context);
const damagedTypes = new Set(damagedAnalysis.markers.map((marker) => marker.type));
assert.ok(damagedTypes.has('mono_incompatibility'), 'anti-phase section should create a mono marker');
assert.ok(damagedTypes.has('sub_bass_heavy'), '40 Hz section should create a sub-bass marker');
assert.ok(damagedTypes.has('clipping'), 'full-scale square wave should create a clipping marker');
assert.ok(damagedAnalysis.issueLoad > 0, 'damaged signal must carry non-zero issue load');

const clean = new FakeBuffer(2, sampleRate * duration, sampleRate);
for (let index = 0; index < clean.length; index++) {
  const time = index / sampleRate;
  const value = Math.sin(2 * Math.PI * 440 * time) * 0.12;
  clean.data[0][index] = value;
  clean.data[1][index] = value;
}
context.clean = clean;
const cleanAnalysis = await vm.runInContext('mfTimelineAnalyze(clean)', context);
assert.ok(cleanAnalysis.issueLoad < damagedAnalysis.issueLoad, 'clean signal should score lower than damaged signal');

const rideSong = new FakeBuffer(2, sampleRate * 8, sampleRate);
for (let index = 0; index < rideSong.length; index++) {
  const time = index / sampleRate;
  const verse = time < 3.4;
  const lowMid = Math.sin(2 * Math.PI * 350 * time) * (verse ? 0.55 : 0.10);
  const presence = Math.sin(2 * Math.PI * 3200 * time) * (verse ? 0.035 : 0.42);
  rideSong.data[0][index] = lowMid + presence;
  rideSong.data[1][index] = lowMid + presence;
}
context.rideSong = rideSong;
const rideAnalysis = await vm.runInContext('mfTimelineAnalyze(rideSong)', context);
assert.doesNotMatch(
  fs.readFileSync(new URL('../js/app-timeline-analysis.js', import.meta.url), 'utf8'),
  /lead_masking/,
  'Problem Timeline must not grow a buried-vocal type',
);
assert.ok(!rideAnalysis.markers.some((marker) => marker.type === 'lead_masking'), 'buried lead is not a targeted-repair / timeline ride');
assert.ok(rideAnalysis.frames.some((frame) => frame.start < 3.4 && Number(frame.lowMidToPresenceDb) > 10), 'frames still expose presence masking for Forensic');

context.clamp = (value, min, max) => Math.max(min, Math.min(max, value));
context.globalThis = context;
vm.runInContext(fs.readFileSync(new URL('../js/app-musician-ux.js', import.meta.url), 'utf8'), context);
context.rideAnalysis = rideAnalysis;
const buried = vm.runInContext('mfFindBuriedVocalWindows(rideAnalysis)', context);
assert.ok(buried.length >= 1, 'Forensic must find the ducked verse from frames, not a timeline type');
assert.ok(buried.every((window) => window.start < 3.6), 'a forward chorus must not get a vocal-stem ride');
assert.ok(buried.every((window) => Number.isFinite(window.start) && Number.isFinite(window.end) && window.end > window.start));

context.sourceAnalysis = damagedAnalysis;
context.masteredAnalysis = cleanAnalysis;
const selfCheck = vm.runInContext('mfTimelineSelfCheck(sourceAnalysis, masteredAnalysis)', context);
assert.ok(['strong_improvement', 'partial_improvement'].includes(selfCheck.assessment), `expected improvement, got ${selfCheck.assessment}`);
assert.ok(selfCheck.resolved.includes('clipping'), 'self-check should report clipping resolved');
assert.ok(selfCheck.scoreAfter < selfCheck.scoreBefore, 'weighted issue load should fall');

const indexHtml = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.match(indexHtml, /id="problemTimeline"/, 'source Problem Timeline mount should exist');
assert.match(indexHtml, /id="masterTimeline"/, 'master Problem Timeline mount should exist');
const analysisScriptIndex = indexHtml.indexOf('/js/app-timeline-analysis.js');
const uiScriptIndex = indexHtml.indexOf('/js/app-timeline-ui.js');
assert.ok(analysisScriptIndex > 0 && uiScriptIndex > analysisScriptIndex, 'analysis must load before timeline UI');
assert.ok(uiScriptIndex > indexHtml.indexOf('/js/app-vocal-cleanup-guard.js'), 'timeline hooks must install after existing guards');

console.log('MixForge timeline smoke tests passed');
