'use strict';

// Final peak verification layer. The mastering renderer can use its fast cubic
// estimator while iterating, then this layer performs a local 4x polyphase FIR
// pass before any null/matched preview is derived from the master.
(function installStandardsPeakVerification() {
  if (typeof renderReleaseMaster !== 'function') return;

  const previousRenderReleaseMaster = renderReleaseMaster;
  const previousRenderVerification = typeof renderVerification === 'function' ? renderVerification : null;
  const WORKLET_URL = '/js/mf-true-peak.worklet.js?v=2.5.0';

  function safetyPadFor(measurement) {
    if (!measurement?.standardsDerived) return 0.55;
    if (measurement.sampleRate === 48000) return 0.05;
    if (measurement.sampleRate === 44100) return 0.15;
    return 0.25;
  }

  function peakSafetyDecision(measuredDb, requestedCeilingDb, measurement) {
    const safetyPadDb = safetyPadFor(measurement);
    const effectiveCeilingDb = requestedCeilingDb - safetyPadDb;
    const trimDb = Number.isFinite(measuredDb) && measuredDb > effectiveCeilingDb
      ? effectiveCeilingDb - measuredDb
      : 0;
    return { safetyPadDb, effectiveCeilingDb, trimDb };
  }

  function applyGainCopy(buffer, gainDb) {
    if (!buffer || !Number.isFinite(gainDb) || Math.abs(gainDb) < 0.0001) return buffer;
    const out = cloneBuffer(buffer);
    const gain = dbToGain(gainDb);
    for (let channel = 0; channel < out.numberOfChannels; channel++) {
      const data = out.getChannelData(channel);
      for (let frame = 0; frame < data.length; frame++) data[frame] *= gain;
    }
    return out;
  }

  async function measureTruePeak4x(buffer) {
    const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (typeof OfflineCtx !== 'function') throw new Error('OfflineAudioContext is unavailable.');
    if (typeof globalThis.AudioWorkletNode !== 'function') throw new Error('AudioWorkletNode is unavailable.');

    const channels = Math.max(1, Math.min(2, Number(buffer.numberOfChannels) || 1));
    const flushFrames = 32;
    const tailFrames = 256;
    const context = new OfflineCtx(channels, buffer.length + tailFrames, buffer.sampleRate);
    if (!context.audioWorklet?.addModule) throw new Error('Offline AudioWorklet is unavailable.');

    await context.audioWorklet.addModule(WORKLET_URL);
    const source = context.createBufferSource();
    source.buffer = buffer;
    const meter = new AudioWorkletNode(context, 'mixforge-true-peak', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [channels],
      channelCount: channels,
      channelCountMode: 'explicit',
      processorOptions: {
        sourceFrames: buffer.length,
        flushFrames,
        channelCount: channels,
      },
    });
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(meter).connect(mute).connect(context.destination);

    let final = null;
    meter.port.onmessage = (event) => {
      if (event.data?.final && Number.isFinite(event.data?.peakDb)) final = event.data;
    };
    source.start(0);
    await context.startRendering();
    // Offline render messages can be queued until the render task returns.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!final || !Number.isFinite(final.peakDb)) {
      throw new Error('The 4x peak worklet did not return a final measurement.');
    }

    return {
      truePeakDb: final.peakDb,
      peakLinear: final.peakLinear,
      sampleRate: buffer.sampleRate,
      oversample: 4,
      tapsPerPhase: 12,
      method: '4x-polyphase-fir',
      standardsDerived: true,
    };
  }

  async function verifyPeak(buffer) {
    try {
      return await measureTruePeak4x(buffer);
    } catch (error) {
      const fallback = Number(typeof mfEstimateTruePeak === 'function' ? mfEstimateTruePeak(buffer) : NaN);
      if (!Number.isFinite(fallback)) throw error;
      return {
        truePeakDb: fallback,
        sampleRate: buffer.sampleRate,
        oversample: 4,
        method: 'cubic-fallback',
        standardsDerived: false,
        error: error?.message || String(error),
      };
    }
  }

  renderReleaseMaster = async function renderStandardsPeakCheckedMaster(...args) {
    let master = await previousRenderReleaseMaster(...args);
    if (!master) return master;

    const requestedCeilingDb = Number(
      state.masterPlan?.truePeakCeilingDb
      ?? state.masterEffectivePlan?.truePeakCeilingDb
      ?? state.masterConstraint?.truePeakCeilingDb
      ?? -1,
    );
    const measurement = await verifyPeak(master);
    const decision = peakSafetyDecision(measurement.truePeakDb, requestedCeilingDb, measurement);

    if (decision.trimDb < -0.0001) master = applyGainCopy(master, decision.trimDb);
    const finalTruePeakDb = measurement.truePeakDb + decision.trimDb;
    const previousConstraint = state.masterConstraint || {};
    const previousAchievedLufs = Number(previousConstraint.achievedLufs);
    state.masterConstraint = {
      ...previousConstraint,
      truePeakDb: finalTruePeakDb,
      truePeakMeasuredBeforeSafetyDb: measurement.truePeakDb,
      truePeakCeilingDb: requestedCeilingDb,
      truePeakEffectiveCeilingDb: decision.effectiveCeilingDb,
      truePeakSafetyPadDb: decision.safetyPadDb,
      truePeakSafetyTrimDb: decision.trimDb,
      truePeakMethod: measurement.method,
      truePeakOversample: measurement.oversample,
      truePeakTapsPerPhase: measurement.tapsPerPhase || null,
      truePeakStandardsDerived: measurement.standardsDerived,
      truePeakMeterError: measurement.error || null,
      achievedLufs: Number.isFinite(previousAchievedLufs)
        ? previousAchievedLufs + decision.trimDb
        : previousConstraint.achievedLufs,
    };
    return master;
  };

  if (previousRenderVerification) {
    renderVerification = function renderStandardsPeakVerification(metrics, plan) {
      previousRenderVerification(metrics, plan);
      const constraint = state.masterConstraint || {};
      if (!Number.isFinite(constraint.truePeakDb)) return;
      const root = $('verificationList');
      if (!root) return;

      // Remove older peak rows so the user sees the measurement that actually
      // gated this final buffer, not the fast estimate used during rendering.
      for (const row of root.querySelectorAll?.('.check') || []) {
        const text = row.textContent || '';
        if (text.includes('true peak') || text.includes('True peak') || text.includes('Estimated true peak')) row.remove();
      }

      const safe = constraint.truePeakDb <= constraint.truePeakCeilingDb + 0.05;
      const row = document.createElement('div');
      row.className = `check ${safe ? '' : 'fail'}`;
      const icon = document.createElement('b');
      icon.textContent = safe ? '✓' : '×';
      const detail = document.createElement('div');
      const label = document.createElement('strong');
      label.textContent = constraint.truePeakStandardsDerived
        ? '4× inter-sample peak check: '
        : 'Peak safety fallback: ';
      const trimText = constraint.truePeakSafetyTrimDb < -0.01
        ? ` · final safety trim ${constraint.truePeakSafetyTrimDb.toFixed(2)} dB`
        : '';
      const methodText = constraint.truePeakStandardsDerived
        ? `polyphase FIR using BS.1770 Annex-2 coefficients; ${constraint.truePeakDb.toFixed(2)} dBTP against ${constraint.truePeakCeilingDb.toFixed(1)} dBTP ceiling${trimText}. Browser implementation; not a certified meter.`
        : `cubic estimate ${constraint.truePeakDb.toFixed(2)} dBTP with an extra ${constraint.truePeakSafetyPadDb.toFixed(2)} dB guard because the local AudioWorklet meter was unavailable${trimText}.`;
      detail.append(label, document.createTextNode(methodText));
      row.append(icon, detail);
      root.append(row);
    };
  }

  globalThis.mixForgeStandardsPeak = {
    safetyPadFor,
    peakSafetyDecision,
    measureTruePeak4x,
    verifyPeak,
  };
})();
