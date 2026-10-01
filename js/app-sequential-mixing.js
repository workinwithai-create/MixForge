'use strict';

// MixForge sequential mixing layer — mix plan, sequential render, stage audition,
// and plain-English explanation.
//
// LOAD POSITION MATTERS. This file must sit immediately AFTER app-forensics.js and
// BEFORE app-separation-provenance.js. Not last.
//
//   * After app-forensics.js  — so it wraps the forensic buildStemPlans() /
//     renderStemPlans() / rebuildCorrectedMix(), not the base ones in app-stems.js.
//   * Before app-signal-integrity.js — so that file's audibility floors are applied
//     to plan.wet after this one runs, and this file reads them back at stage time.
//   * Before app-vocal-cleanup.js — that file wraps rebuildCorrectedMix() and applies
//     vocal-layer cleanup to whatever buffer the previous rebuild returned. Loading
//     this file last would replace that wrapper and silently disable vocal cleanup.
//     Loading it here means cleanup runs on top of the sequential mix instead.
//
// What changes:
//   * After isolation, an ORDERED mix plan is built. The anchor is chosen from what
//     is actually in the song (a present lead vocal, otherwise the strongest
//     melodic/harmonic source) and established first.
//   * Each stage is decided against the CURRENT working mix and the already-placed
//     anchor, rendered, then re-measured. A stage that leaves the mix measurably
//     worse than it found it is retried at half strength and, failing that, undone.
//   * The anchor/accompaniment relationship is measured directly: the placed anchor
//     against everything else in the working mix, in the 2–5 kHz band.
//   * Each source carries a confidence state (separation fit + anchor bleed). How
//     hard a stage may process a source scales with it; some sources are observed
//     but deliberately not processed on their own.
//   * Every stage carries a plain-English heard / changed / why / listen-for note,
//     a producer-style summary leads the log, and every stage can be auditioned.
//
// What does NOT change: panels, transport, mastering chain, export, guards, quotas.
// The original audio is never replaced — every stage is a bounded delta on top of it.

(function installSequentialMix() {
  const ready = typeof buildStemPlans === 'function'
    && typeof rebuildCorrectedMix === 'function'
    && typeof renderProcessedBuffer === 'function'
    && typeof measureBuffer === 'function'
    && typeof cloneBuffer === 'function'
    && typeof bufferRms === 'function'
    && typeof band === 'function';
  if (!ready) {
    console.warn('Sequential mix layer not installed: expected globals are missing.');
    return;
  }

  // Anchor first, then the element most likely to fight the anchor, then the
  // low-end foundation, then groove. Demucs only yields these four buckets.
  const STAGE_ORDER = ['vocals', 'other', 'bass', 'drums'];
  const ROLE = {
    vocals: 'lead vocal',
    other: 'harmonic bed — guitars, keys and ambience share this bucket',
    bass: 'low-end foundation',
    drums: 'groove and transients',
  };
  const NAME = {
    vocals: 'vocal',
    other: 'guitars / keys bucket',
    bass: 'bass',
    drums: 'drums',
  };
  const MAX_TRIM_DB = 2;
  const SNAPSHOT_BUDGET_BYTES = 320 * 1024 * 1024;
  // A stem within this many LU of the full mix is present enough to be what a listener follows.
  const ANCHOR_PRESENT_LU = 20;
  // A stem this far under the full mix is effectively silent and is left alone.
  const SILENT_LU = 30;
  // Lead margin (placed anchor vs. everything else, 2–5 kHz) at which no support
  // stage needs to carve for the anchor any more.
  const CLEAR_MARGIN_DB = 6;
  // Regression tolerances for the re-measure after each stage.
  const TOL = { margin: 0.25, mud: 0.5, lufsDrop: 1.5, peakRise: 1, correlationDrop: 0.05 };

  const seq = {
    plan: null,
    stages: [],
    snapshots: {},
    sources: {},
    assessment: null,
    lastError: null,
    audition: { source: null, key: null, startedAt: 0, offset: 0, matched: true, cache: {} },
  };
  globalThis.mixForgeSequential = seq;

  const gapOf = (m, a, b, side = false) => band(m, a, side) - band(m, b, side);
  const presenceGap = (m) => gapOf(m, 'Low-mids', 'Presence');
  const mudGap = (m) => gapOf(m, 'Low-mids', 'Mids');
  const flareDb = (m) => m.sibilance.p95Db - m.sibilance.medianDb;
  const hasFlares = (m) => m.sibilance.flares > m.sibilance.frames * 0.05;
  const signed = (v, digits = 1) => {
    const text = Math.abs(v).toFixed(digits);
    return Number(text) === 0 ? text : `${v > 0 ? '+' : '-'}${text}`;
  };
  const nameOf = (stem) => NAME[stem] || stem;
  const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
  // "A sits 1.2 dB under B" / "A is 0.8 dB louder than B", from a signed difference A − B.
  const relative = (diff, b) => (diff > 0
    ? `${diff.toFixed(1)} dB louder than ${b}`
    : `within ${Math.abs(diff).toFixed(1)} dB of ${b}`);
  const standing = (anchorName, margin) => (margin >= 0
    ? `the ${anchorName} is only ${margin.toFixed(1)} dB above the rest of the mix`
    : `the rest of the mix is ${Math.abs(margin).toFixed(1)} dB louder than the ${anchorName}`);

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function intensityScale(plan) {
    const selected = plan?.candidates?.[plan.selectedCandidate]?.name?.toLowerCase();
    const mode = selected || (typeof forensicState === 'object' && forensicState?.profile?.intensity) || 'balanced';
    return mode === 'preserve' ? 0.65 : mode === 'assertive' ? 1.25 : 1;
  }

  // app-signal-integrity.js raises plan.wet to an audibility floor after this file's
  // buildStemPlans wrapper runs, because the older conservative defaults made valid
  // repairs effectively inaudible. Never return less than the floor it set.
  function stageWet(plan) {
    const score = plan?.quality?.score ?? 80;
    const base = score >= 82 ? 0.30 : score >= 65 ? 0.20 : 0.10;
    const floor = Number(plan?.wet) || 0;
    return clamp(Math.max(base * intensityScale(plan), floor), 0.06, 0.45);
  }

  // Band energies only — all a relationship check needs, and far cheaper than a
  // full measureBuffer() pass on every attempt.
  function bandsOf(buffer) {
    if (typeof spectralScanChannels !== 'function') return measureBuffer(buffer);
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
    return { midBands: spectralScanChannels(left, right, buffer.sampleRate, 'mid').bands };
  }

  // ------------------------------------------------------- source confidence

  // Normalised correlation of two stems' mono sums. A separated stem that carries
  // a coherent copy of the anchor correlates with it; unrelated instruments sit
  // near zero. Read as an estimate of how much of the anchor bled into the stem.
  function stemCorrelation(a, b) {
    const length = Math.min(a.length, b.length);
    const step = Math.max(1, Math.floor(length / 400000));
    const a0 = a.getChannelData(0), a1 = a.getChannelData(Math.min(1, a.numberOfChannels - 1));
    const b0 = b.getChannelData(0), b1 = b.getChannelData(Math.min(1, b.numberOfChannels - 1));
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < length; i += step) {
      const x = (a0[i] + a1[i]) * 0.5, y = (b0[i] + b1[i]) * 0.5;
      ab += x * y; aa += x * x; bb += y * y;
    }
    return aa > 1e-12 && bb > 1e-12 ? ab / Math.sqrt(aa * bb) : 0;
  }

  // Five states. Processing intensity scales with separation confidence, not with
  // ambition, and a source we cannot trust is observed but not processed alone.
  function assessSource(stem, plan, anchorStem) {
    const score = plan?.quality?.score ?? 80;
    const anchorBuffer = state.stemBuffers?.[anchorStem];
    const bleed = stem !== anchorStem && anchorBuffer && state.stemBuffers?.[stem]
      ? Math.abs(stemCorrelation(state.stemBuffers[stem], anchorBuffer))
      : 0;
    const anchorName = nameOf(anchorStem);
    if (score < 50 || bleed >= 0.35) {
      return {
        state: 'isolate-off', label: 'Do not process independently', scale: 0, score, bleed,
        note: bleed >= 0.35
          ? `It carries a strong copy of the ${anchorName} (bleed estimate ${Math.round(bleed * 100)}%), so anything done to it would be done to the ${anchorName} too.`
          : `The separation fit is poor (${score}%), so it cannot be processed on its own without risking parts of the song.`,
      };
    }
    if (bleed >= 0.12) {
      return {
        state: 'contaminated', label: 'Contaminated', scale: 0.35, score, bleed,
        note: `It carries some of the ${anchorName} (bleed estimate ${Math.round(bleed * 100)}%), so it is not carved in the ${anchorName}'s own range.`,
      };
    }
    if (score < 65) {
      return { state: 'uncertain', label: 'Uncertain', scale: 0.35, score, bleed, note: `The separation fit is weak (${score}%), so only light, broad moves are allowed.` };
    }
    if (score < 82) {
      return { state: 'usable', label: 'Usable', scale: 0.65, score, bleed, note: `Separation fit ${score}% — moderate moves only.` };
    }
    return { state: 'high', label: 'High confidence', scale: 1, score, bleed, note: `Separation fit ${score}%.` };
  }

  // ---------------------------------------------------------------- mix plan

  function mixLufs() {
    return (state.mixMetrics || (state.original ? measureBuffer(state.original) : null))?.lufs ?? -14;
  }

  function stemLufs(stem) {
    return state.stemPlans?.[stem]?.metrics?.lufs ?? -70;
  }

  function chooseAnchor(available, mix) {
    if (available.includes('vocals') && stemLufs('vocals') > mix - ANCHOR_PRESENT_LU) {
      return {
        stem: 'vocals',
        reason: `There is a lead vocal ${(mix - stemLufs('vocals')).toFixed(1)} LU under the full mix, so it is what a listener follows. Everything else is placed around it.`,
      };
    }
    const pool = available.filter((stem) => stem !== 'vocals');
    if (!pool.length) return { stem: available[0], reason: `Only the ${nameOf(available[0])} was isolated, so it is the reference.` };
    const melodic = pool.includes('other') && stemLufs('other') > mix - ANCHOR_PRESENT_LU ? 'other' : null;
    const stem = melodic || [...pool].sort((a, b) => stemLufs(b) - stemLufs(a))[0];
    const vocalNote = available.includes('vocals')
      ? `The vocal stem sits ${(mix - stemLufs('vocals')).toFixed(1)} LU under the mix, so no lead vocal carries this song`
      : 'No vocal was isolated';
    return {
      stem,
      reason: `${vocalNote}. The ${nameOf(stem)} is the strongest ${melodic ? 'melodic/harmonic source' : 'source'}, so it becomes the anchor.`,
    };
  }

  function buildMixPlan() {
    const available = STAGE_ORDER.filter((stem) => state.stemBuffers?.[stem] && state.stemPlans?.[stem]);
    if (!available.length) return null;
    const mix = mixLufs();
    const anchor = chooseAnchor(available, mix);
    const skipped = [];
    const included = available.filter((stem) => {
      if (stem === anchor.stem) return true;
      if (stemLufs(stem) < mix - SILENT_LU) {
        skipped.push({ stem, reason: `effectively silent (${(mix - stemLufs(stem)).toFixed(0)} LU under the mix), left untouched` });
        return false;
      }
      return true;
    });
    const ordered = [anchor.stem, ...included.filter((stem) => stem !== anchor.stem)];
    const stages = ordered.map((stem, index) => ({
      index: index + 1,
      stem,
      role: stem === anchor.stem ? `anchor (${ROLE[stem] || stem})` : ROLE[stem] || stem,
      goal: stem === anchor.stem
        ? 'Establish the anchor and correct it on its own terms. Everything after this is judged against it.'
        : goalFor(stem, anchor.stem),
    }));
    const missing = STAGE_ORDER.filter((stem) => !available.includes(stem));
    return { anchor: anchor.stem, anchorReason: anchor.reason, stages, missing, skipped };
  }

  function goalFor(stem, anchor) {
    if (stem === 'other') return `Support the ${nameOf(anchor)} harmonically without occupying the same upper-mid space.`;
    if (stem === 'bass') return 'Carry weight underneath what is already placed without eating headroom.';
    if (stem === 'drums') return `Reinforce the groove without covering the ${nameOf(anchor)} or fighting the bass.`;
    if (stem === 'vocals') return `Sit with the ${nameOf(anchor)} rather than on top of it.`;
    return `Sit behind the ${nameOf(anchor)}.`;
  }

  // ------------------------------------------------------------- stage logic

  function untouched(stem, source) {
    return {
      operations: [],
      trimDb: 0,
      wet: 0,
      heard: `The ${nameOf(stem)} cannot be trusted on its own. ${source.note}`,
      changed: 'nothing — it stays exactly as it is in the original',
      why: 'Preserving musical information beats a repair that cannot be verified. Whatever this stem needs is left to the whole-mix stages.',
      listenFor: 'No change here by design.',
    };
  }

  function planAnchor(stem, sm, ctx) {
    if (!ctx.source.scale) return untouched(stem, ctx.source);
    const operations = [];
    const heard = [];
    const k = ctx.source.scale * intensityScale(ctx.plan);
    const name = nameOf(stem);

    if (mudGap(sm) > 6) {
      operations.push({
        type: 'eq', filterType: 'peaking', frequency: 320, q: 1.1,
        gain: -clamp((mudGap(sm) - 5) * 0.35 * k, 0.6, 3),
        label: 'Reduce boxiness in the anchor',
      });
      heard.push(`it carries ${mudGap(sm).toFixed(1)} dB more low-mid than mid energy, which reads as boxy`);
    }
    if (stem === 'vocals' && hasFlares(sm) && flareDb(sm) > 7) {
      operations.push({
        type: 'deess', frequency: 6800, threshold: -30,
        label: 'Hold back sibilant peaks only',
      });
      heard.push(`${sm.sibilance.flares} sibilant flares jump ${flareDb(sm).toFixed(1)} dB above its normal top end`);
    }
    if (sm.crestDb > 18) {
      operations.push({
        type: 'compressor', threshold: -22, ratio: clamp(2.2 * intensityScale(ctx.plan), 1.4, 3),
        attack: 0.025, release: 0.16, knee: 5,
        label: 'Steady the anchor so it holds its place',
      });
      heard.push(`it moves across a ${sm.crestDb.toFixed(1)} dB crest range, so its position in the mix keeps shifting`);
    }

    return {
      operations,
      trimDb: 0,
      wet: stageWet(ctx.plan),
      heard: heard.length
        ? `The ${name} is what the song hangs on — ${heard.join(', and ')}.`
        : `The ${name} already sits cleanly on its own; nothing measured argues for touching it.`,
      changed: operations.length
        ? operations.map((op) => op.label.toLowerCase()).join(', ')
        : 'nothing — it was left alone on purpose',
      why: 'This is the reference every later decision is measured against, so it gets corrected first and then stays put.',
      listenFor: operations.length
        ? 'The lead should sound like itself, just steadier and less congested.'
        : 'No change here by design.',
    };
  }

  function planSupport(stem, sm, ctx) {
    if (!ctx.source.scale) return untouched(stem, ctx.source);
    const anchor = ctx.anchorMetrics;
    const anchorName = nameOf(ctx.anchorStem);
    const name = nameOf(stem);
    const operations = [];
    const heard = [];
    const k = ctx.source.scale * intensityScale(ctx.plan);
    let trimDb = 0;
    let carveSkipped = false;

    // Re-read after every stage: how clear the placed anchor already is of
    // everything else in the band where words and melody live. If an earlier
    // stage already opened it up, later stages carve less — or not at all.
    const margin = ctx.leadMargin;
    const pressure = margin == null ? 0 : clamp((CLEAR_MARGIN_DB - margin) / 8, 0, 1);

    if (anchor) {
      const compete = band(sm, 'Presence') - band(anchor, 'Presence');
      if (compete > -3 && pressure > 0.1) {
        if (ctx.source.state === 'contaminated') {
          carveSkipped = true;
          heard.push(`it competes with the ${anchorName} in the 2–5 kHz band, but it also carries some of the ${anchorName} itself`);
        } else {
          operations.push({
            type: 'eq', filterType: 'peaking', frequency: 3000, q: 1.2,
            gain: -clamp((compete + 3) * 0.35 * k * pressure, 0.5, 2.5),
            label: `Carve upper-mid room for the ${anchorName}`,
          });
          heard.push(`it is ${relative(compete, `the ${anchorName}`)} in the 2–5 kHz band, where ${standing(anchorName, margin)}`);
        }
        if (compete > 0) trimDb -= clamp(compete * 0.3 * k * pressure, 0, MAX_TRIM_DB);
      }
      const lowClash = band(sm, 'Low-mids') - band(anchor, 'Low-mids');
      if (lowClash > -2 && mudGap(ctx.workingMetrics) > 6) {
        operations.push({
          type: 'eq', filterType: 'peaking', frequency: 350, q: 1,
          gain: -clamp((lowClash + 2) * 0.3 * k, 0.5, 2.2),
          label: `Thin the low-mid pile-up under the ${anchorName}`,
        });
        heard.push(`the mix as it stands still shows ${mudGap(ctx.workingMetrics).toFixed(1)} dB of low-mid over mid energy`);
      }
    }

    if (stem === 'bass') {
      const sub = gapOf(sm, 'Sub', 'Bass');
      if (sub > 2) {
        operations.push({
          type: 'eq', filterType: 'lowshelf', frequency: 55, q: 0.7,
          gain: -clamp((sub - 1) * 0.5 * k, 0.5, 3),
          label: 'Keep sub weight from eating the headroom',
        });
        heard.push(`its sub band runs ${sub.toFixed(1)} dB hotter than its bass band`);
      }
      if (sm.crestDb > 16) {
        operations.push({
          type: 'compressor', threshold: -24, ratio: clamp(2.5 * intensityScale(ctx.plan), 1.4, 3.2),
          attack: 0.035, release: 0.18, knee: 5,
          label: 'Even out note-to-note level',
        });
      }
    }

    if (stem === 'drums') {
      const placedBass = ctx.mixed.bass;
      if (placedBass) {
        const clash = band(sm, 'Bass') - band(placedBass, 'Bass');
        if (clash > -3) {
          operations.push({
            type: 'eq', filterType: 'peaking', frequency: 120, q: 1,
            gain: -clamp((clash + 3) * 0.25 * k, 0.4, 2),
            label: 'Tuck the kick under the bass that is already placed',
          });
          heard.push(`the kick region is ${relative(clash, 'the bass that was placed in the previous stage')}`);
        }
      }
      if (sm.crestDb > 22 && ctx.workingMetrics.crestDb > 9) {
        operations.push({
          type: 'compressor', threshold: -20, ratio: 1.8, attack: 0.035, release: 0.12, knee: 4,
          label: 'Light glue so the kit reads as one thing',
        });
      }
    }

    const nothing = !operations.length && Math.abs(trimDb) < 0.05;
    const madeRoom = trimDb < -0.05 || operations.some((op) => /^(Carve|Thin)/.test(op.label));
    const lowEnd = {
      bass: {
        why: 'The low end goes in under what is already placed, so it adds weight without taking headroom from everything above it.',
        listenFor: 'A steadier low end and a little more headroom, without the song losing weight.',
      },
      drums: {
        why: 'The kick and the bass that is already placed now take turns in the low end instead of stacking on each other.',
        listenFor: 'Whether the kick still punches while the bass note stays defined underneath it.',
      },
    }[stem];
    const clearAlready = margin != null && pressure <= 0.1;
    return {
      operations,
      trimDb,
      wet: stageWet(ctx.plan),
      heard: heard.length
        ? `Against the mix as it stands, ${heard.join(', and ')}.`
        : clearAlready
          ? `The ${anchorName} already stands ${margin.toFixed(1)} dB above the rest of the mix in the 2–5 kHz band, and the ${name} is not causing a measured problem.`
          : `Measured against the mix as it stands, the ${name} is not causing a problem.`,
      changed: nothing
        ? (carveSkipped ? `nothing — carving it would also carve the ${anchorName}` : 'nothing — it was already sitting correctly relative to what came before')
        : [
          ...operations.map((op) => op.label.toLowerCase()),
          Math.abs(trimDb) >= 0.05 ? `pulled it back ${Math.abs(trimDb).toFixed(1)} dB` : null,
        ].filter(Boolean).join(', '),
      why: nothing
        ? 'No change is a decision. Nothing in the current mix justified touching it.'
        : !madeRoom && lowEnd
          ? lowEnd.why
          : `Space was made around the ${anchorName} rather than pushing the ${anchorName} harder, so the lead keeps its tone.`,
      listenFor: nothing
        ? 'Nothing should change at this stage.'
        : !madeRoom && lowEnd
          ? lowEnd.listenFor
          : `Whether the ${anchorName} reads more clearly here without sounding brighter or louder.`,
    };
  }

  // ------------------------------------------------------------ stage render

  async function applyStage(working, stemBuffer, decision) {
    if (working.sampleRate !== stemBuffer.sampleRate || working.length !== stemBuffer.length) {
      throw new Error('Stem timing does not match the original mix. Separate it again before rebuilding.');
    }
    const out = cloneBuffer(working);
    const effectiveStem = cloneBuffer(stemBuffer);
    const processed = decision.operations.length
      ? await renderProcessedBuffer(stemBuffer, decision.operations)
      : stemBuffer;
    if (processed.sampleRate !== stemBuffer.sampleRate || processed.length !== stemBuffer.length || processed.numberOfChannels !== stemBuffer.numberOfChannels) {
      throw new Error('Processed stem timing or channels changed.');
    }
    const rawRms = bufferRms(stemBuffer);
    const fixedRms = bufferRms(processed);
    const match = fixedRms > 1e-8 ? clamp(rawRms / fixedRms, dbToGain(-2), dbToGain(2)) : 1;
    const wet = clamp(decision.wet, 0.05, 0.45);
    const trim = dbToGain(clamp(decision.trimDb || 0, -MAX_TRIM_DB, MAX_TRIM_DB)) - 1;
    const length = Math.min(out.length, stemBuffer.length, processed.length);
    for (let c = 0; c < effectiveStem.numberOfChannels; c++) {
      const raw = stemBuffer.getChannelData(c), fixed = processed.getChannelData(c);
      const effective = effectiveStem.getChannelData(c);
      for (let i = 0; i < length; i++) effective[i] = raw[i] + (fixed[i] * match - raw[i]) * wet + raw[i] * trim;
    }
    for (let c = 0; c < out.numberOfChannels; c++) {
      const dest = out.getChannelData(c);
      const raw = stemBuffer.getChannelData(Math.min(c, stemBuffer.numberOfChannels - 1));
      const fixed = effectiveStem.getChannelData(Math.min(c, effectiveStem.numberOfChannels - 1));
      for (let i = 0; i < length; i++) {
        dest[i] += fixed[i] - raw[i];
      }
    }
    return { mix: out, stem: effectiveStem };
  }

  const changes = (decision) => decision.operations.length > 0 || Math.abs(decision.trimDb || 0) > 0.05;

  function scaled(decision, factor) {
    return { ...decision, wet: decision.wet * factor, trimDb: (decision.trimDb || 0) * factor };
  }

  // Everything in the working mix except the placed anchor.
  function accompanimentOf(working, anchorBuffer) {
    const out = cloneBuffer(working);
    const length = Math.min(out.length, anchorBuffer.length);
    for (let c = 0; c < out.numberOfChannels; c++) {
      const dest = out.getChannelData(c);
      const lead = anchorBuffer.getChannelData(Math.min(c, anchorBuffer.numberOfChannels - 1));
      for (let i = 0; i < length; i++) dest[i] -= lead[i];
    }
    return out;
  }

  // How far the placed anchor stands clear of everything else in the 2–5 kHz band.
  function leadMarginOf(working, anchorBuffer, anchorBands) {
    if (!anchorBuffer || !anchorBands) return null;
    return band(anchorBands, 'Presence') - band(bandsOf(accompanimentOf(working, anchorBuffer)), 'Presence');
  }

  // Do not assume the decision was right. Compare the mix after the stage with
  // the mix before it; anything that got measurably worse is a regression.
  function regressions(before, after, isAnchor) {
    const found = [];
    if (!isAnchor && before.margin != null && after.margin != null && after.margin < before.margin - TOL.margin) {
      found.push(`the lead margin fell ${(before.margin - after.margin).toFixed(1)} dB`);
    }
    if (mudGap(after.metrics) > mudGap(before.metrics) + TOL.mud) found.push('low-mid build-up increased');
    if (after.metrics.lufs < before.metrics.lufs - TOL.lufsDrop) found.push(`the mix lost ${(before.metrics.lufs - after.metrics.lufs).toFixed(1)} LU`);
    if (after.metrics.peakDb > before.metrics.peakDb + TOL.peakRise) found.push(`peaks rose ${(after.metrics.peakDb - before.metrics.peakDb).toFixed(1)} dB`);
    if (after.metrics.correlation < before.metrics.correlation - TOL.correlationDrop) found.push('the stereo image lost mono compatibility');
    return found;
  }

  function canSnapshot(stageCount) {
    if (!state.original) return false;
    const bytes = state.original.length * state.original.numberOfChannels * 4 * Math.max(1, stageCount);
    return bytes <= SNAPSHOT_BUDGET_BYTES;
  }

  function progress(message) {
    if (typeof setStatus === 'function') setStatus('rebuildStatus', message, 'busy');
  }

  async function renderSequentialMix() {
    seq.plan = buildMixPlan();
    seq.lastError = null;
    if (!seq.plan) throw new Error('No isolated stems are available to mix.');
    stopAudition();
    seq.audition.cache = {};
    seq.audition.offset = 0;

    const anchorStem = seq.plan.anchor;
    let anchorMetrics = null;
    let anchorBuffer = null;
    const baseline = state.mixMetrics || measureBuffer(state.original);
    const keep = canSnapshot(seq.plan.stages.length);

    let working = cloneBuffer(state.original);
    let workingMetrics = baseline;
    let leadMargin = null;
    const mixed = {};
    seq.stages = [];
    seq.snapshots = {};
    seq.sources = {};
    seq.assessment = null;

    for (const stage of seq.plan.stages) {
      const stemBuffer = state.stemBuffers[stage.stem];
      const plan = state.stemPlans[stage.stem];
      if (!stemBuffer || !plan) continue;
      const isAnchor = stage.stem === anchorStem;

      progress(`Stage ${stage.index} of ${seq.plan.stages.length} — placing the ${nameOf(stage.stem)} against the mix as it stands…`);
      const sm = plan.metrics || measureBuffer(stemBuffer);
      const source = assessSource(stage.stem, plan, anchorStem);
      seq.sources[stage.stem] = source;
      const ctx = { plan, source, workingMetrics, anchorMetrics, anchorStem, mixed, leadMargin };
      const decision = isAnchor ? planAnchor(stage.stem, sm, ctx) : planSupport(stage.stem, sm, ctx);

      const before = { metrics: workingMetrics, margin: leadMargin };
      let after = isAnchor
        ? { metrics: workingMetrics, margin: leadMarginOf(working, stemBuffer, sm) }
        : before;
      let applied = null;
      let placedStem = stemBuffer;
      let placedBands = sm;
      const attempts = [];

      if (changes(decision)) {
        for (const factor of [1, 0.5]) {
          const attempt = scaled(decision, factor);
          const result = await applyStage(working, stemBuffer, attempt);
          const stemBands = bandsOf(result.stem);
          const candidate = {
            metrics: measureBuffer(result.mix),
            margin: isAnchor
              ? leadMarginOf(result.mix, result.stem, stemBands)
              : leadMarginOf(result.mix, anchorBuffer, anchorMetrics),
          };
          const problems = regressions(before, candidate, isAnchor);
          attempts.push({ factor, problems });
          if (!problems.length) {
            applied = attempt;
            working = result.mix;
            placedStem = result.stem;
            placedBands = stemBands;
            after = candidate;
            break;
          }
        }
      }

      mixed[stage.stem] = placedBands;
      if (isAnchor) {
        anchorMetrics = placedBands;
        anchorBuffer = placedStem;
      }
      // Do not assume the decision stayed correct. The next stage reads the mix again.
      workingMetrics = after.metrics;
      leadMargin = after.margin;

      const reverted = changes(decision) && !applied;
      const backedOff = Boolean(applied) && applied.wet < decision.wet;
      const finalDecision = reverted
        ? {
          ...decision,
          operations: [],
          trimDb: 0,
          changed: `nothing in the end — I tried to ${decision.changed}, but the mix measured worse (${attempts[attempts.length - 1].problems.join('; ')}), so I undid it`,
          why: 'A move that makes the song measurably worse is not kept, even when the plan called for it.',
          listenFor: 'Nothing should change at this stage.',
        }
        : backedOff
          ? { ...decision, changed: `${decision.changed} — at half strength, because the full move measured worse (${attempts[0].problems.join('; ')})` }
          : decision;

      // Reflect the sequential decision back onto the existing stem card.
      plan.sequential = finalDecision;
      plan.operations = applied ? applied.operations : [];
      plan.wet = applied ? applied.wet : decision.wet;

      seq.stages.push({
        ...stage,
        source,
        decision: finalDecision,
        applied,
        attempts,
        reverted,
        backedOff,
        before: before.metrics,
        after: workingMetrics,
        marginBefore: before.margin,
        marginAfter: leadMargin,
        delta: {
          lufs: workingMetrics.lufs - before.metrics.lufs,
          presenceGap: presenceGap(workingMetrics) - presenceGap(before.metrics),
          mud: mudGap(workingMetrics) - mudGap(before.metrics),
          correlation: workingMetrics.correlation - before.metrics.correlation,
          margin: before.margin != null && leadMargin != null ? leadMargin - before.margin : null,
        },
      });
      if (keep) seq.snapshots[stage.index] = cloneBuffer(working);
      await sleep(0);
    }

    if (typeof forensicState === 'object' && forensicState) {
      forensicState.reconstruction = {
        peakShift: workingMetrics.peakDb - baseline.peakDb,
        lufsShift: workingMetrics.lufs - baseline.lufs,
        widthShift: workingMetrics.widthDb - baseline.widthDb,
        correlationShift: workingMetrics.correlation - baseline.correlation,
      };
    }
    seq.assessment = producerAssessment();
    // Re-render the cards so they show the moves that were actually kept.
    if (typeof renderStemPlans === 'function') renderStemPlans();
    renderStageLog();
    return working;
  }

  // Replays stages 1..index from the untouched original using the decisions that
  // were actually kept. Deterministic, so any stage can be auditioned even when
  // the song is too long to hold every stage in memory.
  async function renderStage(index) {
    if (!index) return state.original;
    if (seq.snapshots[index]) return seq.snapshots[index];
    if (seq.audition.cache[index]) return seq.audition.cache[index];
    let working = cloneBuffer(state.original);
    for (const stage of seq.stages) {
      if (stage.index > index) break;
      if (stage.applied) working = (await applyStage(working, state.stemBuffers[stage.stem], stage.applied)).mix;
    }
    seq.audition.cache = { [index]: working };
    return working;
  }

  // ------------------------------------------------------ producer assessment

  function producerAssessment() {
    if (!seq.stages.length) return null;
    const anchorStage = seq.stages.find((stage) => stage.stem === seq.plan.anchor);
    const anchorName = nameOf(seq.plan.anchor);
    const lines = [];

    if (anchorStage?.applied) {
      lines.push(`The ${anchorName} is carrying this song. It got a small correction of its own first (${anchorStage.decision.changed.replace(/ — at half strength.*$/, '')}), then stayed put as the reference for everything else.`);
    } else if (anchorStage?.source.state === 'isolate-off') {
      lines.push(`The ${anchorName} is carrying this song, but its separation is not clean enough to touch on its own, so I built around it as it is.`);
    } else {
      lines.push(`The ${anchorName} is carrying this song and already sits well, so I left it where it was and built around it.`);
    }

    const supports = seq.stages.filter((stage) => stage.stem !== seq.plan.anchor);
    const biggest = supports
      .filter((stage) => stage.applied && (stage.delta.margin ?? 0) > 0.05)
      .sort((a, b) => b.delta.margin - a.delta.margin)[0];
    if (biggest) {
      const what = biggest.decision.heard.replace(/^Against the mix as it stands, /, '').replace(/\.$/, '');
      lines.push(`The biggest thing in its way was the ${nameOf(biggest.stem)}: ${what}. I made room there instead of pushing the ${anchorName} harder.`);
    } else if (supports.some((stage) => stage.applied)) {
      lines.push(`Nothing was seriously fighting the ${anchorName}; the remaining moves were small and mostly about the low end.`);
    } else if (supports.length) {
      lines.push(`Nothing else measured as getting in the ${anchorName}'s way, so the other elements were left as they are.`);
    }

    for (const stage of supports) {
      if (stage.reverted) lines.push(`I tried a move on the ${nameOf(stage.stem)}, but it made the mix measurably worse, so I undid it.`);
      else if (stage.source.state === 'isolate-off') lines.push(`I left the ${nameOf(stage.stem)} alone: ${stage.source.note}`);
    }

    const startMargin = anchorStage?.marginAfter ?? null;
    const endMargin = seq.stages[seq.stages.length - 1]?.marginAfter ?? null;
    const marginLine = startMargin != null && endMargin != null && supports.length
      ? `Measured in the 2–5 kHz band, the ${anchorName} against everything else moved from ${signed(startMargin)} dB to ${signed(endMargin)} dB (higher means it stands further forward).`
      : null;

    return { summary: lines.join(' '), marginLine, startMargin, endMargin };
  }

  // -------------------------------------------------------------------- UI

  // Insert before the panel's own rebuild-actions row. Stem cards contain nested
  // `.actions` rows (Vocal Layer Cleanup audition), which insertBefore() rejects —
  // and a throw here used to abort the sequential mix after it had rendered.
  function ensureBlock(id, heading) {
    let block = typeof $ === 'function' ? $(id) : null;
    if (block) {
      block.replaceChildren();
    } else {
      const panel = typeof $ === 'function' ? $('stemPanel') : null;
      if (!panel) return null;
      block = el('section', 'forensic-block');
      block.id = id;
      const actions = Array.from(panel.children || []).find((node) => node.classList?.contains('actions')) || null;
      panel.insertBefore(block, actions);
    }
    block.append(el('h3', '', heading));
    return block;
  }

  function removeBlock(id) {
    const block = typeof $ === 'function' ? $(id) : null;
    block?.remove();
  }

  function renderMixPlan() {
    if (!seq.plan) return;
    const block = ensureBlock('mixPlanPanel', 'Mix plan — the order this song will be built in');
    if (!block) return;
    block.append(el('p', 'stem-guidance', `Anchor: ${nameOf(seq.plan.anchor)}. ${seq.plan.anchorReason}`));
    block.append(el('p', 'stem-guidance',
      'Each stage is decided against the mix as it stands after the stage before it, then measured again. A stage that leaves the mix measurably worse is backed off or undone.'));
    const list = el('div', 'repair-list');
    for (const stage of seq.plan.stages) {
      const row = el('div', 'repair');
      row.append(el('span', '', `${stage.index}. ${capital(nameOf(stage.stem))} — ${stage.role}`), el('span', '', stage.goal));
      list.append(row);
    }
    const bus = el('div', 'repair');
    bus.append(el('span', '', `${seq.plan.stages.length + 1}. Mix bus and release master`),
      el('span', '', 'Only after the stems are placed: cohesion, loudness and true-peak safety in the mastering step below.'));
    list.append(bus);
    block.append(list);
    for (const skip of seq.plan.skipped) {
      block.append(el('small', 'guardrail', `${capital(nameOf(skip.stem))}: ${skip.reason}.`));
    }
    if (seq.plan.missing.length) {
      block.append(el('small', 'guardrail',
        `Not isolated this session: ${seq.plan.missing.map(nameOf).join(', ')}. Those elements stay inside the untouched original and are not processed.`));
    }
  }

  function marginBadge(stage) {
    if (stage.marginAfter == null) return '';
    if (stage.marginBefore == null) return `lead margin ${signed(stage.marginAfter)} dB`;
    return `lead margin ${signed(stage.marginBefore)} → ${signed(stage.marginAfter)} dB`;
  }

  function renderStageLog() {
    if (!seq.stages.length) return;
    const block = ensureBlock('mixStageLog', 'How the mix was built');
    if (!block) return;
    if (seq.assessment) {
      const ear = el('article', 'finding low');
      ear.append(el('h3', '', 'Producer assessment'));
      ear.append(el('p', 'action', seq.assessment.summary));
      if (seq.assessment.marginLine) ear.append(el('p', '', seq.assessment.marginLine));
      block.append(ear);
    }
    renderAudition(block);
    for (const stage of seq.stages) {
      const card = el('article', `finding ${stage.reverted ? 'medium' : 'low'}`);
      const top = el('div', 'finding-top');
      const badges = [stage.source.label, marginBadge(stage), `Δ loudness ${signed(stage.delta.lufs, 2)} LU`].filter(Boolean).join(' · ');
      top.append(el('h3', '', `Stage ${stage.index} · ${capital(nameOf(stage.stem))}`), el('span', 'badge', badges));
      card.append(top);
      card.append(el('p', '', `What I heard: ${stage.decision.heard}`));
      card.append(el('p', '', `What I changed: ${stage.decision.changed}.`));
      card.append(el('p', 'consequence', `Why: ${stage.decision.why}`));
      card.append(el('p', 'action', `Listen for: ${stage.decision.listenFor}`));
      if (stage.source.state !== 'high' && stage.source.state !== 'isolate-off') {
        card.append(el('small', 'guardrail', `Source confidence: ${stage.source.note}`));
      }
      block.append(card);
    }
    block.append(el('small', 'guardrail',
      'Every stage is a bounded delta on the untouched original. "Lead margin" is how far the placed anchor stands above everything else in the 2–5 kHz band, measured on the separated stems. It is evidence, not proof of clarity — judge it by ear with the stage player.'));
  }

  // -------------------------------------------------------- stage audition

  function auditionTargets() {
    const targets = [{ key: 'original', label: 'Original', index: 0 }];
    for (const stage of seq.stages) {
      targets.push({ key: `stage-${stage.index}`, label: `After ${stage.index} · ${capital(nameOf(stage.stem))}`, index: stage.index });
    }
    targets.push({ key: 'rebuilt', label: 'Rebuilt mix → mastering', index: null });
    return targets;
  }

  function lufsFor(target) {
    if (target.key === 'original') return (state.mixMetrics || seq.stages[0]?.before)?.lufs;
    if (target.key === 'rebuilt') return state.correctedMetrics?.lufs;
    return seq.stages.find((stage) => stage.index === target.index)?.after?.lufs;
  }

  function auditionPosition() {
    const a = seq.audition;
    if (a.source && state.audioCtx) return a.offset + (state.audioCtx.currentTime - a.startedAt);
    return a.offset;
  }

  function syncAuditionButtons() {
    const root = typeof $ === 'function' ? $('stageAudition') : null;
    if (!root) return;
    for (const button of root.querySelectorAll('button[data-stage]')) {
      button.classList.toggle('selected', Boolean(seq.audition.source) && button.dataset.stage === seq.audition.key);
    }
  }

  function stopAudition() {
    const a = seq.audition;
    if (!a.source) return;
    a.offset = auditionPosition();
    const source = a.source;
    a.source = null;
    try { source.onended = null; source.stop(); } catch (_) {}
    try { source.disconnect(); } catch (_) {}
    syncAuditionButtons();
  }

  function auditionStatus(message, kind = '') {
    const status = typeof $ === 'function' ? $('stageAuditionStatus') : null;
    if (!status) return;
    status.textContent = message;
    status.className = `status${kind ? ` ${kind}` : ''}`;
  }

  async function playAudition(target) {
    try {
      // One thing plays at a time: stop the main transport before auditioning.
      if (typeof stopTransport === 'function') stopTransport({ preservePosition: true });
      else if (typeof stopPreview === 'function') stopPreview();
      const position = auditionPosition();
      stopAudition();
      let buffer;
      if (target.key === 'rebuilt') {
        buffer = state.corrected;
        if (!buffer) throw new Error('the rebuilt mix is not ready yet');
      } else {
        if (target.index && !seq.snapshots[target.index] && !seq.audition.cache[target.index]) {
          auditionStatus(`Rendering stage ${target.index}…`, 'busy');
        }
        buffer = await renderStage(target.index);
      }
      const ctx = await ensureAudioContext(true);
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      const reference = lufsFor({ key: 'original' });
      const level = lufsFor(target);
      const matchDb = seq.audition.matched && Number.isFinite(reference) && Number.isFinite(level)
        ? clamp(reference - level, -6, 6)
        : 0;
      gain.gain.value = dbToGain(matchDb);
      source.buffer = buffer;
      source.connect(gain).connect(ctx.destination);
      const offset = clamp(position, 0, Math.max(0, buffer.duration - 0.05));
      source.onended = () => {
        if (seq.audition.source !== source) return;
        seq.audition.source = null;
        seq.audition.offset = 0;
        syncAuditionButtons();
      };
      seq.audition.source = source;
      seq.audition.key = target.key;
      seq.audition.offset = offset;
      seq.audition.startedAt = ctx.currentTime;
      source.start(0, offset);
      syncAuditionButtons();
      auditionStatus(`Playing: ${target.label}${Math.abs(matchDb) >= 0.05 ? ` · level-matched ${signed(matchDb)} dB` : ''}`, 'ok');
    } catch (error) {
      console.error(error);
      auditionStatus(`Could not play this stage: ${error.message}`, 'error');
    }
  }

  function renderAudition(block) {
    const box = el('div', 'stage-audition');
    box.id = 'stageAudition';
    box.append(el('p', 'stem-guidance',
      'Hear the mix being built. Switching keeps your place in the song, and level-matched playback compares balance rather than volume. "Rebuilt mix" also includes Vocal Layer Cleanup when it is on.'));
    const choices = el('div', 'candidate-choices');
    for (const target of auditionTargets()) {
      const button = el('button', '', target.label);
      button.type = 'button';
      button.dataset.stage = target.key;
      button.onclick = () => playAudition(target);
      choices.append(button);
    }
    const stop = el('button', '', '■ Stop');
    stop.type = 'button';
    stop.onclick = () => { stopAudition(); seq.audition.offset = 0; auditionStatus(''); };
    choices.append(stop);
    box.append(choices);
    const label = el('label', 'stem-guidance');
    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.checked = seq.audition.matched;
    toggle.onchange = () => { seq.audition.matched = toggle.checked; };
    label.append(toggle, document.createTextNode(' Level-match to the original'));
    box.append(label);
    const status = el('div', 'status');
    status.id = 'stageAuditionStatus';
    status.setAttribute('aria-live', 'polite');
    box.append(status);
    block.append(box);
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    // The main transport and the stage player never play over each other.
    document.addEventListener('click', (event) => {
      if (event.target?.closest?.('#playBtn, .ab-btn')) stopAudition();
    });
  }

  // -------------------------------------------------------------- wiring

  const baseBuildStemPlans = buildStemPlans;
  buildStemPlans = async function buildStemPlansWithMixPlan() {
    await baseBuildStemPlans();
    stopAudition();
    seq.plan = buildMixPlan();
    seq.stages = [];
    seq.snapshots = {};
    seq.sources = {};
    seq.assessment = null;
    seq.audition.cache = {};
    seq.audition.offset = 0;
    removeBlock('mixStageLog');
  };

  const baseRenderStemPlans = renderStemPlans;
  renderStemPlans = function renderStemPlansWithMixPlan() {
    baseRenderStemPlans();
    annotateStemCards();
    renderMixPlan();
  };

  // The forensic cards list each stem measured on its own. Say plainly which moves
  // were actually applied by the sequential build, and which are only a start point.
  function annotateStemCards() {
    const grid = typeof $ === 'function' ? $('stemGrid') : null;
    if (!grid?.querySelectorAll) return;
    const cards = grid.querySelectorAll('.stem-card');
    Object.keys(state.stemPlans || {}).forEach((stem, index) => {
      const card = cards[index];
      if (!card) return;
      const stage = seq.stages.find((item) => item.stem === stem);
      const text = stage
        ? `Sequential build, stage ${stage.index}: ${stage.decision.changed}. The list above is what was applied.`
        : seq.plan?.skipped?.some((item) => item.stem === stem)
          ? 'Sequential build: left untouched.'
          : 'Starting point only. At rebuild, this stem\'s moves are decided again against the mix as it stands (see the mix plan below).';
      card.append(el('small', 'guardrail', text));
    });
  }

  rebuildCorrectedMix = async function rebuildCorrectedMixSequential() {
    try {
      return await renderSequentialMix();
    } catch (error) {
      seq.lastError = error;
      seq.stages = [];
      seq.snapshots = {};
      seq.assessment = null;
      if (typeof setStatus === 'function') {
        setStatus('rebuildStatus', `Sequential mix could not complete: ${error.message}`, 'error');
      }
      throw error;
    }
  };

  seq.renderStage = renderStage;
  seq.stemCorrelation = stemCorrelation;
})();
