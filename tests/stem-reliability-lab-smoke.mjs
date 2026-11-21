import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The Stem Reliability Lab page. The maths lives in js/app-stem-reliability-core.js and is proved with real
// numbers in tests/stem-reliability-core-smoke.mjs; this file checks the page keeps its own promises.
const html = await readFile(new URL('../stem-reliability-lab.html', import.meta.url), 'utf8');
const core = await readFile(new URL('../js/app-stem-reliability-core.js', import.meta.url), 'utf8');

// What the page explains and links to.
assert.match(html, /decodeAudioData/);
assert.match(html, /least-squares gain fit/i);
assert.match(html, /residual/i);
assert.match(html, /exact-sum residual/i);
assert.match(html, /correlation/i);
assert.match(html, /first 90 seconds/i);
assert.match(html, /nothing is uploaded/i);
assert.match(html, /does not prove/i);
assert.match(html, /https:\/\/arxiv\.org\/abs\/2611\.09358/);
assert.match(html, /https:\/\/arxiv\.org\/abs\/2611\.16933/);
assert.match(html, /https:\/\/github\.com\/rapidly-labs\/rapidly-sdk/);
assert.match(html, /96 ms stated latency/i);
assert.match(html, /WebAssembly is not yet available/i);
assert.match(html, /\['guitar','Guitar stem','Optional'\]/);
assert.match(html, /\['piano','Piano stem','Optional'\]/);
assert.match(html, /\['residualBus','Residual bus','Optional'\]/);
assert.match(html, /lossy input detected/i);
assert.match(html, /stemdeckapp\/stemdeck\/releases\/tag\/v0\.21\.0/);
assert.match(html, /UVR6/);
assert.match(html, /December 11, 2026/);
assert.match(html, /ultimatevocalremovergui\/issues\/2399/);

// It uses the shared module, loaded before the page script, and does not keep a second copy of the maths.
assert.ok(html.indexOf('<script src="/js/app-stem-reliability-core.js"></script>') > 0);
assert.ok(html.indexOf('<script src="/js/app-stem-reliability-core.js"></script>') < html.indexOf('lab.auditStems('));
assert.match(html, /lab\.auditStems\(/);
assert.match(html, /lab\.toReceipt\(report/);
assert.match(html, /lab\.isLossy\(file\.name,file\.type\)/);
assert.doesNotMatch(html, /exactResidualEnergy|fittedGain=Math/, 'the page holds no private copy of the reconstruction maths');

// Audition: switching sources quickly never orphans the playing source or breaks Stop.
assert.match(html, /playback===source/);
assert.match(html, /source\.onended=null/);
assert.doesNotMatch(html, /playback\.onended=\(\)=>playback=null/);

// Duration checks use each file's full decoded length (before the 90-second cap), and the page says what a mismatch means.
assert.match(html, /mix:\{channels:channelsOf\(decoded\.mix\),durationSec:decoded\.mix\.duration\}/);
assert.match(html, /durationSec:buffer\.duration/);
assert.match(html, /missing tail samples are scored as silence/i);
assert.match(core, /durationMismatches/);
assert.match(core, /!durationMismatches\.length/, 'a duration mismatch blocks an unqualified strong verdict');
assert.doesNotMatch(core, /Math\.min\(\.\.\.tracks|Math\.min\(\.\.\.Object\.values\(tracks\)/, 'the audit window is never the shortest file');
assert.doesNotMatch(html, /length=Math\.min\(\.\.\.Object\.values\(tracks\)/);

// The receipt is built from a snapshot of the files chosen when the audit started, with inputs locked meanwhile.
assert.match(html, /Download audit report/i);
assert.match(html, /selectedFiles=new Map\(files\)/);
assert.match(html, /for\(const \[id,file\] of selectedFiles\)/);
assert.match(html, /sourceFiles:\[\.\.\.selectedFiles\.entries\(\)\]/);
assert.doesNotMatch(html, /sourceFiles:\[\.\.\.files\.entries\(\)\]/);
assert.match(html, /fileInputs\.forEach\(input=>input\.disabled=true\)/);
assert.match(html, /fileInputs\.forEach\(input=>input\.disabled=false\)/);
assert.ok(html.indexOf('selectedFiles=new Map(files)') < html.indexOf('await audioContext.decodeAudioData'), 'the snapshot is taken before the first await');
assert.match(html, /new Blob\(\[JSON\.stringify\(analyzed\.report/);
assert.match(core, /schemaVersion: 1/);
assert.match(core, /gainFittedResidualDb/);

// Privacy: neither the page nor the shared module has a network path.
for (const [name, text] of [['lab page', html], ['core module', core]]) {
  assert.doesNotMatch(text, /fetch\s*\(/, `${name} never fetches`);
  assert.doesNotMatch(text, /XMLHttpRequest|WebSocket|sendBeacon/, `${name} has no network path`);
}

console.log('stem reliability lab smoke test passed');
