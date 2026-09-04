'use strict';

// MixForge sequential mixing layer — Phase 1 (mix plan) + Phase 2 (sequential render).
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
//   * After isolation, an ORDERED mix plan is built. The anchor is established first.
//   * The rebuild no longer decides every stem independently against the original mix.
//     Each stage is decided against the CURRENT working mix and the already-placed
//     anchor, rendered, then re-measured before the next stage is decided.
//   * Every stage carries a plain-English heard / changed / why / listen-for note.
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
    vocals: 'foreground anchor',
    other: 'harmonic bed — guitars, keys and ambience share this bucket',
    bass: 'low-end foundation',
    drums: 'groove and transients',
  };
  const MAX_TRIM_DB = 2;
  const SNAPSHOT_BUDGET_BYTES = 320 * 1024 * 1024;

  const seq = { plan: null, stages: [], snapshots: {}, lastError: null };
  globalThis.mixForgeSequential = seq;

  const gapOf = (m, a, b, side = false) => band(m, a, side) - band(m, b, side);
  const presenceGap = (m) => gapOf(m, 'Low-mids', 'Presence');
  const mudGap = (m) => gapOf(m, 'Low-mids', 'Mids');
  const flareDb = (m) => m.sibilance.p95Db - m.sibilance.medianDb;
  const hasFlares = (m) => m.sibilance.flares > m.sibilance.frames * 0.05;
  const signed = (v, digits = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function intensityScale() {
    const mode = (typeof forensicState === 'object' && forensicState?.profile?.intensity) || 'balanced';
    return mode === 'preserve' ? 0.65 : mode === 'assertive' ? 1.25 : 1;
  }

  // Processing intensity scales with separation confidence, not with ambition.
  function confidenceScale(plan) {
    const score = plan?.quality?.score ?? 80;
    return score >= 82 ? 1 : score >= 65 ? 0.65 : 0.35;
  }

  // app-signal-integrity.js raises plan.wet to an audibility floor after this file's
  // buildStemPlans wrapper runs, because the older conservative defaults made valid
  // repairs effectively inaudible. Never return less than the floor it set.
  function stageWet(plan) {
    const score = plan?.quality?.score ?? 80;
    const base = score >= 82 ? 0.30 : score >= 65 ? 0.20 : 0.10;
    const floor = Number(plan?.wet) || 0;
    return clamp(Math.max(base * intensityScale(), floor), 0.06, 0.45);
  }

  // ---------------------------------------------------------------- mix plan

  function buildMixPlan() {
    const available = STAGE_ORDER.filter((stem) => state.stemBuffers[stem] && state.stemPlans[stem]);
    if (!available.length) return null;
    const anchor = available.includes('vocals') ? 'vocals' : available[0];
    const ordered = [anchor, ...available.filter((stem) => stem !== anchor)];
    const stages = ordered.map((stem, index) => ({
      index: index + 1,
      stem,
      role: ROLE[stem] || stem,
      goal: stem === anchor
        ? 'Establish the anchor and correct it on its own terms. Everything after this is judged against it.'
        : goalFor(stem, anchor),
    }));
    const missing = STAGE_ORDER.filter((stem) => !available.includes(stem));
    return { anchor, stages, missing };
  }

  function goalFor(stem, anchor) {
    if (stem === 'other') return `Support the ${anchor} harmonically without occupying the same upper-mid space.`;
    if (stem === 'bass') return 'Carry weight underneath what is already placed without eating headroom.';
    if (stem === 'drums') return 'Reinforce the groove without covering the anchor or fighting the bass.';
    return `Sit behind the ${anchor}.`;
  }

  // ------------------------------------------------------------- stage logic

  function planAnchor(stem, sm, ctx) {
    const operations = [];
    const heard = [];
    const k = confidenceScale(ctx.plan) * intensityScale();

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
        type: 'compressor', threshold: -22, ratio: clamp(2.2 * intensityScale(), 1.4, 3),
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
        ? `The ${stem} is what the song hangs on — ${heard.join(', and ')}.`
        : `The ${stem} already sits cleanly on its own; nothing measured argues for touching it.`,
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
    const anchor = ctx.anchorMetrics;
    const anchorStem = ctx.anchorStem;
    const operations = [];
    const heard = [];
    const k = confidenceScale(ctx.plan) * intensityScale();
    let trimDb = 0;

    // Re-read after every stage: how hard the mix is still fighting for lead clarity.
    // If an earlier stage already opened the lead up, later stages carve less.
    const pressure = clamp((presenceGap(ctx.workingMetrics) - 11) / 6, 0, 1);

    if (anchor) {
      const compete = band(sm, 'Presence') - band(anchor, 'Presence');
      if (compete > -3 && pressure > 0.1) {
        operations.push({
          type: 'eq', filterType: 'peaking', frequency: 3000, q: 1.2,
          gain: -clamp((compete + 3) * 0.35 * k * pressure, 0.5, 2.5),
          label: `Carve upper-mid room for the ${anchorStem}`,
        });
        heard.push(`it sits within ${Math.abs(compete).toFixed(1)} dB of the ${anchorStem} in the 2–5 kHz band where words live`);
        if (compete > 0) trimDb -= clamp(compete * 0.3 * k * pressure, 0, MAX_TRIM_DB);
      }
      const lowClash = band(sm, 'Low-mids') - band(anchor, 'Low-mids');
      if (lowClash > -2 && mudGap(ctx.workingMetrics) > 6) {
        operations.push({
          type: 'eq', filterType: 'peaking', frequency: 350, q: 1,
          gain: -clamp((lowClash + 2) * 0.3 * k, 0.5, 2.2),
          label: 'Thin the low-mid pile-up under the lead',
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
          type: 'compressor', threshold: -24, ratio: clamp(2.5 * intensityScale(), 1.4, 3.2),
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
          heard.push(`the kick region is within ${Math.abs(clash).toFixed(1)} dB of the bass that was placed in the previous stage`);
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
    return {
      operations,
      trimDb,
      wet: stageWet(ctx.plan),
      heard: heard.length
        ? `Against the mix as it stands, ${heard.join(', and ')}.`
        : `Measured against the mix as it stands, the ${stem} is not causing a problem.`,
      changed: nothing
        ? 'nothing — it was already sitting correctly relative to what came before'
        : [
          ...operations.map((op) => op.label.toLowerCase()),
          Math.abs(trimDb) >= 0.05 ? `pulled it back ${Math.abs(trimDb).toFixed(1)} dB` : null,
        ].filter(Boolean).join(', '),
      why: nothing
        ? 'No change is a decision. Nothing in the current mix justified touching it.'
        : `Space was made around the ${anchorStem} rather than pushing the ${anchorStem} harder, so the lead keeps its tone.`,
      listenFor: nothing
        ? 'Nothing should change at this stage.'
        : `Whether the ${anchorStem} reads more clearly here without sounding brighter or louder.`,
    };
  }

  // ------------------------------------------------------------ stage render

  async function applyStage(working, stemBuffer, decision) {
    const out = cloneBuffer(working);
    const processed = decision.operations.length
      ? await renderProcessedBuffer(stemBuffer, decision.operations)
      : stemBuffer;
    const rawRms = bufferRms(stemBuffer);
    const fixedRms = bufferRms(processed);
    const match = fixedRms > 1e-8 ? clamp(rawRms / fixedRms, dbToGain(-2), dbToGain(2)) : 1;
    const wet = clamp(decision.wet, 0.05, 0.45);
    const trim = dbToGain(clamp(decision.trimDb || 0, -MAX_TRIM_DB, MAX_TRIM_DB)) - 1;
    const length = Math.min(out.length, stemBuffer.length, processed.length);
    for (let c = 0; c < out.numberOfChannels; c++) {
      const dest = out.getChannelData(c);
      const raw = stemBuffer.getChannelData(Math.min(c, stemBuffer.numberOfChannels - 1));
      const fixed = processed.getChannelData(Math.min(c, processed.numberOfChannels - 1));
      for (let i = 0; i < length; i++) {
        dest[i] += (fixed[i] * match - raw[i]) * wet + raw[i] * trim;
      }
    }
    return out;
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
    seq.plan = seq.plan || buildMixPlan();
    if (!seq.plan) throw new Error('No isolated stems are available to mix.');

    const anchorStem = seq.plan.anchor;
    const anchorMetrics = state.stemPlans[anchorStem]?.metrics || null;
    const baseline = state.mixMetrics || measureBuffer(state.original);
    const keep = canSnapshot(seq.plan.stages.length);

    let working = cloneBuffer(state.original);
    let workingMetrics = baseline;
    const mixed = {};
    seq.stages = [];
    seq.snapshots = {};

    for (const stage of seq.plan.stages) {
      const stemBuffer = state.stemBuffers[stage.stem];
      const plan = state.stemPlans[stage.stem];
      if (!stemBuffer || !plan) continue;

      progress(`Stage ${stage.index} of ${seq.plan.stages.length} — placing ${stage.stem} against the mix as it stands…`);
      const sm = plan.metrics || measureBuffer(stemBuffer);
      const ctx = { plan, workingMetrics, anchorMetrics, anchorStem, mixed };
      const decision = stage.stem === anchorStem ? planAnchor(stage.stem, sm, ctx) : planSupport(stage.stem, sm, ctx);

      const before = workingMetrics;
      if (decision.operations.length || Math.abs(decision.trimDb) > 0.05) {
        working = await applyStage(working, stemBuffer, decision);
      }
      // Do not assume the decision stayed correct. Measure the song again.
      workingMetrics = measureBuffer(working);
      mixed[stage.stem] = sm;

      // Reflect the sequential decision back onto the existing stem card.
      plan.sequential = decision;
      if (decision.operations.length) plan.operations = decision.operations;
      plan.wet = decision.wet;

      seq.stages.push({
        ...stage,
        decision,
        before,
        after: workingMetrics,
        delta: {
          lufs: workingMetrics.lufs - before.lufs,
          presenceGap: presenceGap(workingMetrics) - presenceGap(before),
          mud: mudGap(workingMetrics) - mudGap(before),
          correlation: workingMetrics.correlation - before.correlation,
        },
      });
      if (keep) seq.snapshots[stage.stem] = cloneBuffer(working);
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
    renderStageLog();
    return working;
  }

  // -------------------------------------------------------------------- UI

  function panelHost() {
    const panel = $('stemPanel');
    if (!panel) return null;
    return panel;
  }

  function ensureBlock(id, heading) {
    let block = $(id);
    if (block) { block.replaceChildren(); } else {
      const panel = panelHost();
      if (!panel) return null;
      block = el('section', 'forensic-block');
      block.id = id;
      panel.insertBefore(block, panel.querySelector('.actions'));
    }
    block.append(el('h3', '', heading));
    return block;
  }

  function renderMixPlan() {
    if (!seq.plan) return;
    const block = ensureBlock('mixPlanPanel', 'Mix plan — the order this song will be built in');
    if (!block) return;
    block.append(el('p', 'stem-guidance',
      `Anchor: ${seq.plan.anchor}. Each stage is decided against the mix as it stands after the stage before it, not against the original in isolation.`));
    const list = el('div', 'repair-list');
    for (const stage of seq.plan.stages) {
      const row = el('div', 'repair');
      row.append(el('span', '', `${stage.index}. ${stage.stem} — ${stage.role}`), el('span', '', stage.goal));
      list.append(row);
    }
    block.append(list);
    if (seq.plan.missing.length) {
      block.append(el('small', 'guardrail',
        `Not isolated this session: ${seq.plan.missing.join(', ')}. Those elements stay inside the untouched original and are not processed.`));
    }
  }

  function renderStageLog() {
    if (!seq.stages.length) return;
    const block = ensureBlock('mixStageLog', 'What happened at each stage');
    if (!block) return;
    for (const stage of seq.stages) {
      const card = el('article', 'finding low');
      const top = el('div', 'finding-top');
      top.append(
        el('h3', '', `Stage ${stage.index} · ${stage.stem}`),
        el('span', 'badge', `Δ clarity ${signed(-stage.delta.presenceGap)} dB · Δ loudness ${signed(stage.delta.lufs, 2)} LU`),
      );
      card.append(top);
      card.append(el('p', '', `What I heard: ${stage.decision.heard}`));
      card.append(el('p', '', `What I changed: ${stage.decision.changed}.`));
      card.append(el('p', 'consequence', `Why: ${stage.decision.why}`));
      card.append(el('p', 'action', `Listen for: ${stage.decision.listenFor}`));
      block.append(card);
    }
    block.append(el('small', 'guardrail',
      'Every stage is a bounded delta on the untouched original. Clarity delta is the measured low-mid to presence gap closing; a positive number means the lead reads more clearly.'));
  }

  // -------------------------------------------------------------- wiring

  const baseBuildStemPlans = buildStemPlans;
  buildStemPlans = async function buildStemPlansWithMixPlan() {
    await baseBuildStemPlans();
    seq.plan = buildMixPlan();
    seq.stages = [];
    seq.snapshots = {};
  };

  const baseRenderStemPlans = renderStemPlans;
  renderStemPlans = function renderStemPlansWithMixPlan() {
    baseRenderStemPlans();
    renderMixPlan();
  };

  const baseRebuild = rebuildCorrectedMix;
  rebuildCorrectedMix = async function rebuildCorrectedMixSequential() {
    try {
      return await renderSequentialMix();
    } catch (error) {
      // Never lose the ability to finish a session. Fall back to the previous
      // parallel rebuild and record why.
      console.error('Sequential mix failed; falling back to parallel rebuild.', error);
      seq.lastError = error;
      if (typeof setStatus === 'function') {
        setStatus('rebuildStatus', `Sequential mix could not complete (${error.message}). Falling back to the previous rebuild.`, 'warn');
      }
      return baseRebuild();
    }
  };
})();