'use strict';

// Can these stems rebuild the song? Pure maths, no DOM, no Web Audio and no network, so the
// same code runs in the Stem Reliability Lab, in "Put your song back together", and in Node tests.
//
// Given the original mix and the stems separated from it, it measures
//   - the exact-sum residual: mix minus the plain stem sum (catches missing parts and hidden level changes),
//   - the gain-fitted residual: the same after one best-fit level correction (what is still unaccounted for),
//   - the highest correlation between any two stems (the same part showing up in two stems),
//   - each stem's level against the mix, near-empty stems, and stems whose length does not match.
// Without a mix it still checks the stems against each other (lengths, near-empty, shared content).
// Thresholds are product heuristics, not research benchmarks. A strong result does not prove that
// "vocals" contains only vocals.
(() => {
  const MAX_SECONDS = 90;            // analysis covers the first 90 seconds
  const DURATION_TOLERANCE_SEC = 0.01;
  const NEAR_EMPTY_DB = -36;         // a stem this far under the mix is "near-empty"
  const STRONG_RESIDUAL_DB = -20;
  const REVIEW_RESIDUAL_DB = -12;
  const SHARED_CONTENT = 0.65;       // correlation at or above this flags duplicated content
  const STRIDE_TARGET = 1500000;     // energy sums sample at most about this many frames
  const LOSSY_NAME = /\.(mp3|m4a|aac|ogg|opus|webm)$/i;
  const LOSSY_TYPE = /^(audio|video)\/(mpeg|mp3|mp4|aac|x-m4a|ogg|opus|webm)\b/i;

  const db = (x) => 10 * Math.log10(Math.max(x, 1e-12));
  const round = (value, digits) => Number(Number(value).toFixed(digits));

  // MP3, AAC, Ogg, Opus and WebM encoding changes the samples, so an exact-sum comparison can show
  // a residual even when the separator returned complete stems.
  function isLossy(name = '', type = '') {
    return LOSSY_NAME.test(String(name)) || LOSSY_TYPE.test(String(type));
  }

  // The first maxFrames frames, all channels averaged to one.
  function monoOf(channels, maxFrames) {
    const list = (channels || []).filter(Boolean);
    const frames = list.reduce((max, ch) => Math.max(max, ch.length), 0);
    const n = Math.min(frames, maxFrames);
    const out = new Float32Array(n);
    for (const channel of list) {
      const end = Math.min(n, channel.length);
      for (let i = 0; i < end; i++) out[i] += channel[i] / list.length;
    }
    return out;
  }

  const fullDuration = (part, sampleRate) => (Number.isFinite(part?.durationSec)
    ? Number(part.durationSec)
    : ((part?.channels || []).reduce((max, ch) => Math.max(max, ch.length), 0) / sampleRate));

  // mix:   { channels: Float32Array[], durationSec } or null
  // stems: [{ id, channels: Float32Array[], durationSec }]
  // Durations are the full decoded lengths, so a mismatch past the 90-second window is still caught.
  function auditStems({ sampleRate, mix = null, stems = [], maxSeconds = MAX_SECONDS } = {}) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('A sample rate is needed to check the stems.');
    const live = (stems || []).filter((s) => s && Array.isArray(s.channels) && s.channels.length);
    if (!live.length) throw new Error('Choose at least one stem.');
    const maxFrames = Math.round(sampleRate * maxSeconds);
    const tracks = live.map((s) => ({ id: String(s.id), samples: monoOf(s.channels, maxFrames), durationSec: fullDuration(s, sampleRate) }));
    const against = mix ? 'mix' : 'stems';
    const mixTrack = mix ? monoOf(mix.channels, maxFrames) : null;
    // With a mix, the whole analysed stretch of the mix is scored: a stem that stops early counts as silence there.
    const length = mixTrack ? mixTrack.length : tracks.reduce((max, t) => Math.max(max, t.samples.length), 0);
    if (length < sampleRate) throw new Error(mix ? 'Use a mix with at least one second of audio.' : 'The stems hold less than one second of audio.');
    const referenceDuration = mix ? fullDuration(mix, sampleRate) : tracks.reduce((max, t) => Math.max(max, t.durationSec), 0);
    const durationMismatches = tracks.filter((t) => Math.abs(t.durationSec - referenceDuration) > DURATION_TOLERANCE_SEC).map((t) => t.id);

    const stride = Math.max(1, Math.floor(length / STRIDE_TARGET));
    const rawSum = new Float32Array(length);
    for (const track of tracks) {
      const n = Math.min(length, track.samples.length);
      for (let i = 0; i < n; i++) rawSum[i] += track.samples[i];
    }
    let sumEnergy = 0;
    for (let i = 0; i < length; i += stride) sumEnergy += rawSum[i] * rawSum[i];

    let metrics = { gainFittedResidualDb: null, exactSumResidualDb: null, amplitudeCoverage: null, fittedGain: null };
    let referenceEnergy = sumEnergy;
    let audio = { mix: null, sum: rawSum, residual: null };
    if (mixTrack) {
      let mixEnergy = 0;
      let dot = 0;
      let exactResidualEnergy = 0;
      for (let i = 0; i < length; i += stride) {
        const m = mixTrack[i];
        const s = rawSum[i];
        mixEnergy += m * m;
        dot += m * s;
        exactResidualEnergy += (m - s) * (m - s);
      }
      const exactSumDb = db(exactResidualEnergy / Math.max(mixEnergy, 1e-12));
      // One global level correction, least squares, kept within ±12 dB so a broken file cannot fit by accident.
      const fittedGain = Math.max(0.25, Math.min(4, dot / Math.max(sumEnergy, 1e-12)));
      const fittedSum = new Float32Array(length);
      const residual = new Float32Array(length);
      let residualEnergy = 0;
      for (let i = 0; i < length; i++) {
        fittedSum[i] = rawSum[i] * fittedGain;
        residual[i] = mixTrack[i] - fittedSum[i];
        if (i % stride === 0) residualEnergy += residual[i] * residual[i];
      }
      const ratio = residualEnergy / Math.max(mixEnergy, 1e-12);
      metrics = {
        gainFittedResidualDb: round(db(ratio), 2),
        exactSumResidualDb: round(exactSumDb, 2),
        amplitudeCoverage: round(1 - Math.sqrt(ratio), 4),
        fittedGain: round(fittedGain, 4),
      };
      referenceEnergy = mixEnergy;
      audio = { mix: mixTrack, sum: fittedSum, residual };
    }

    let maxCorrelation = 0;
    let maxPair = null;
    for (let a = 0; a < tracks.length; a++) {
      for (let b = a + 1; b < tracks.length; b++) {
        const x = tracks[a].samples;
        const y = tracks[b].samples;
        let xy = 0;
        let xx = 0;
        let yy = 0;
        for (let i = 0; i < length; i += stride) {
          const p = i < x.length ? x[i] : 0;
          const q = i < y.length ? y[i] : 0;
          xy += p * q; xx += p * p; yy += q * q;
        }
        const correlation = Math.abs(xy) / Math.sqrt(Math.max(xx * yy, 1e-12));
        if (correlation > maxCorrelation) { maxCorrelation = correlation; maxPair = [tracks[a].id, tracks[b].id]; }
      }
    }
    metrics.maxStemCorrelation = tracks.length > 1 ? round(maxCorrelation, 4) : null;

    const nearEmptyStems = [];
    const stemResults = tracks.map((track) => {
      let energy = 0;
      const n = Math.min(length, track.samples.length);
      for (let i = 0; i < n; i += stride) energy += track.samples[i] * track.samples[i];
      const relative = db(energy / Math.max(referenceEnergy, 1e-12));
      const nearEmpty = relative < NEAR_EMPTY_DB;
      if (nearEmpty) nearEmptyStems.push(track.id);
      return {
        id: track.id,
        relativeLevelDb: round(relative, 2),
        nearEmpty,
        durationMismatch: durationMismatches.includes(track.id),
        durationSeconds: round(track.durationSec, 3),
      };
    });

    const sharedContent = tracks.length > 1 && maxCorrelation >= SHARED_CONTENT;
    let verdict;
    if (!mixTrack) {
      const clean = !durationMismatches.length && !nearEmptyStems.length && !sharedContent;
      verdict = clean
        ? { label: 'Stems line up: same length, none near-empty, no shared content flagged. There is no original mix to compare against.', className: 'good' }
        : { label: 'Review recommended: inspect the flagged stems. There is no original mix to compare against.', className: 'review' };
    } else if (metrics.gainFittedResidualDb <= STRONG_RESIDUAL_DB && !sharedContent && !nearEmptyStems.length && !durationMismatches.length) {
      verdict = { label: 'Strong reconstruction: ready for a focused listening check.', className: 'good' };
    } else if (metrics.gainFittedResidualDb <= REVIEW_RESIDUAL_DB) {
      verdict = { label: 'Review recommended: usable reconstruction, but inspect the flagged risks.', className: 'review' };
    } else {
      verdict = { label: 'Weak reconstruction: check alignment, missing stems, or separator output.', className: 'weak' };
    }

    return {
      schemaVersion: 1,
      analysis: {
        sampleRate,
        channelMode: 'mono',
        against,
        windowSeconds: round(length / sampleRate, 3),
        maxWindowSeconds: maxSeconds,
      },
      metrics,
      maxCorrelationPair: sharedContent ? maxPair : null,
      stems: stemResults,
      flags: { durationMismatches, nearEmptyStems, sharedContent },
      verdict,
      // Mono audio for listening (original, fitted stem sum, what is left over). Never part of a receipt.
      audio: { sampleRate, length, ...audio },
    };
  }

  // The report as a shareable receipt: numbers and file names only, never audio.
  function toReceipt(report, { sourceFiles = [], generatedAt = new Date().toISOString() } = {}) {
    return {
      schemaVersion: report.schemaVersion,
      generatedAt,
      privacy: 'Created locally; no audio uploaded.',
      sourceFiles,
      analysis: { ...report.analysis },
      metrics: { ...report.metrics },
      stems: report.stems.map((s) => ({ ...s })),
      flags: {
        durationMismatches: [...report.flags.durationMismatches],
        nearEmptyStems: [...report.flags.nearEmptyStems],
        sharedContent: report.flags.sharedContent,
      },
      verdict: { ...report.verdict },
    };
  }

  // The same result in a musician's words: one headline and, only when something needs attention, short notes.
  function describe(report) {
    const list = (ids) => ids.join(', ');
    const notes = [];
    const { durationMismatches, nearEmptyStems, sharedContent } = report.flags;
    if (durationMismatches.length) {
      notes.push(`The ${list(durationMismatches)} stem${durationMismatches.length === 1 ? ' is' : 's are'} a different length from ${report.analysis.against === 'mix' ? 'the original mix' : 'the longest stem'}, so ${durationMismatches.length === 1 ? 'it' : 'they'} may come from a different version of the song.`);
    }
    if (nearEmptyStems.length) {
      notes.push(`The ${list(nearEmptyStems)} stem${nearEmptyStems.length === 1 ? ' is' : 's are'} almost silent. That is fine if the song has no ${list(nearEmptyStems)}; otherwise that part was not captured.`);
    }
    if (sharedContent && report.maxCorrelationPair) {
      notes.push(`The ${report.maxCorrelationPair[0]} and ${report.maxCorrelationPair[1]} stems share a lot of the same sound, so changing one also changes part of the other.`);
    }
    let headline;
    if (report.analysis.against !== 'mix') {
      if (notes.length) headline = 'Check these stems before you mix.';
      else if (report.stems.length === 1) headline = 'One stem, and it is not empty.';
      else headline = `${report.stems.length} stems line up: same length, none is empty, and no two carry the same part.`;
    } else {
      const residualDb = report.metrics.gainFittedResidualDb;
      const leftover = Math.abs(residualDb).toFixed(0);
      if (report.verdict.className === 'good') {
        headline = `The stems add back up to the original mix. What they leave out is ${leftover} dB quieter than the song.`;
      } else if (residualDb <= STRONG_RESIDUAL_DB) {
        headline = `The stems add back up to the original mix (what they leave out is ${leftover} dB down), with something to check first.`;
      } else if (report.verdict.className === 'review') {
        headline = `The stems mostly add back up to the original mix (what they leave out is ${leftover} dB down). Listen to what is left over before you rely on them.`;
      } else {
        headline = `The stems do not add back up to the original mix (what they leave out is only ${leftover} dB down). A part is missing, or the stems come from a different version of the song.`;
      }
    }
    return { headline, notes, tone: report.verdict.className };
  }

  globalThis.MixForgeStemReliability = {
    auditStems, toReceipt, describe, isLossy, monoOf,
    LIMITS: { MAX_SECONDS, DURATION_TOLERANCE_SEC, NEAR_EMPTY_DB, STRONG_RESIDUAL_DB, REVIEW_RESIDUAL_DB, SHARED_CONTENT },
  };
})();
