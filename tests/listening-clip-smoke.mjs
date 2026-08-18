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
  Float32Array,
  Uint8Array,
  DataView,
  Buffer,
  String,
  Error,
});
context.globalThis = context;
vm.runInContext(fs.readFileSync(new URL('../js/app-listening-clip.js', import.meta.url), 'utf8'), context);

const buffer = new FakeBuffer(2, 44100 * 12, 44100);
for (let index = 0; index < buffer.length; index++) {
  const loud = index > 44100 * 8;
  const value = Math.sin(2 * Math.PI * 220 * index / 44100) * (loud ? 0.95 : 0.12);
  buffer.data[0][index] = value;
  buffer.data[1][index] = value * 0.85;
}

const windows = context.pickListeningWindows(buffer);
assert.ok(windows.length >= 1);
assert.ok(windows.some((window) => window.reason.includes('loudest') || window.end > 6));
const total = windows.reduce((sum, window) => sum + (window.end - window.start), 0);
assert.ok(total <= context.MF_LISTEN_MAX_SECONDS + 0.01, `listening windows exceeded budget: ${total}`);

const clip = context.buildListeningClip(buffer);
assert.equal(clip.mimeType, 'audio/wav');
assert.equal(clip.channels, 1);
assert.ok(clip.data.length > 100);
assert.ok(clip.data.length < 3200000);
assert.ok(clip.durationSec <= 20.1);
assert.ok(clip.windows.length >= 1);
assert.match(clip.data, /^[A-Za-z0-9+/]+=*$/);

console.log('listening-clip-smoke: ok');
