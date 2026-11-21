import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// One split gives the whole song: whichever stems the scan points at, the separation asks for all four,
// so the stems saved on a song can always put it back together. Runs the page's real click handler.
const source = readFileSync(new URL('../js/app-audit.js', import.meta.url), 'utf8');
const start = source.indexOf("$('separateBtn').addEventListener('click'");
assert.ok(start > 0, 'the separation handler exists');
const end = source.indexOf('\n});', start) + 4;
const handlerCode = source.slice(start, end);

async function run(audit) {
  const asked = [];
  const statuses = [];
  let handler = null;
  const button = { disabled: false, addEventListener: (_type, fn) => { handler = fn; } };
  const panel = { scrollIntoView() {} };
  const state = { audit, stemBuffers: {} };
  const deps = {
    $: (id) => (id === 'separateBtn' ? button : panel),
    state,
    separateRequiredStems: async (stems) => { asked.push([...stems]); return Object.fromEntries(stems.map((s) => [s, `https://stems.example/${s}.wav`])); },
    setStatus: (_id, message, kind) => statuses.push(`${kind}:${message}`),
    ensureAudioContext: async () => ({}),
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }),
    decodeAudioDataSafe: async () => ({ length: 8 }),
    buildStemPlans: async () => {},
    renderStemPlans: () => {},
    reveal: () => {},
    console: { error() {} },
  };
  new Function(...Object.keys(deps), handlerCode)(...Object.values(deps));
  await handler();
  return { asked, state, statuses };
}

// The scan pointed at three stems (the usual vocals, bass, other): all four are split and loaded.
{
  const { asked, state, statuses } = await run({ stemsToInspect: ['vocals', 'bass', 'other'] });
  assert.deepEqual(asked, [['vocals', 'drums', 'bass', 'other']]);
  assert.deepEqual(Object.keys(state.stemBuffers), ['vocals', 'drums', 'bass', 'other'], 'every part is downloaded and measured');
  assert.deepEqual(state.audit.stemSuspects, ['vocals', 'bass', 'other'], 'what the scan pointed at is kept for the record');
  assert.deepEqual(state.audit.stemsToInspect, ['vocals', 'drums', 'bass', 'other']);
  assert.ok(statuses.at(-1).startsWith('ok:'));
}
// One suspect is enough to split the whole song.
assert.deepEqual((await run({ stemsToInspect: ['other'] })).asked, [['vocals', 'drums', 'bass', 'other']]);
// Suspects recorded earlier (by the Forensic path screen) are not overwritten.
assert.deepEqual((await run({ stemsToInspect: ['vocals', 'drums', 'bass', 'other'], stemSuspects: ['vocals'] })).state.audit.stemSuspects, ['vocals']);
// Nothing pointed at: no split is started.
assert.deepEqual((await run({ stemsToInspect: [] })).asked, []);

// The Forensic path says so before the split, and the server-side separator is unchanged
// (it has always computed all four and uploaded the ones asked for).
const ux = readFileSync(new URL('../js/app-musician-ux.js', import.meta.url), 'utf8');
assert.match(ux, /stemsToInspect: \['vocals', 'drums', 'bass', 'other'\]/);
assert.match(ux, /split once into all four parts and all four are kept/);
assert.match(ux, /One split counts as four stems/);
const handler = readFileSync(new URL('../runpod-separator/handler.py', import.meta.url), 'utf8');
assert.match(handler, /for stem in requested:/);
console.log('complete split smoke ok');
