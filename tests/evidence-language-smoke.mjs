import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

let masterCopy = '';
const context = vm.createContext({
  console,
  state: {
    masterPlan: { truePeakCeilingDb: -1 },
    masterConstraint: {
      truePeakDb: -1.07,
      truePeakCeilingDb: -1,
      truePeakMethod: '4x-polyphase-fir',
      truePeakStandardsDerived: true,
      truePeakSafetyPadDb: 0.05,
      truePeakSafetyTrimDb: -0.12,
    },
  },
  forensicState: { references: [] },
  mfPlainWhatChanged() {
    return {
      headline: 'Measured change',
      bullets: [
        'Loudness -18.0 → -12.0 LUFS (+6.0).',
        'Sample peak -5.00 → -1.20 dBFS.',
        'True-peak estimate -5.00 → -1.20 dBTP (ceiling -1.0; cubic-interp, not a certified meter).',
      ],
      remaining: [],
    };
  },
  mfBuildReadinessReportText() {
    return 'After\n- LUFS: -12.0\n- Peak: -1.20 dBFS\n- True peak: -1.07 dBTP\n- Readiness: 91\n\nWhat changed\n';
  },
  mfUpdateMasterCopy() { masterCopy = 'old cubic-interp copy'; },
  document: {
    querySelector(selector) {
      if (selector !== '#masterPanel .panel-title p') return null;
      return {
        get textContent() { return masterCopy; },
        set textContent(value) { masterCopy = value; },
      };
    },
  },
});
context.globalThis = context;
vm.runInContext(fs.readFileSync(new URL('../js/app-evidence-language.js', import.meta.url), 'utf8'), context);

let summary = context.mfPlainWhatChanged({}, {}, {}, 'quick', {});
assert.equal(summary.peakEvidence.method, '4x-polyphase-fir');
assert.match(summary.bullets[2], /Final inter-sample peak -1\.07 dBTP/);
assert.match(summary.bullets[2], /4× polyphase FIR/);
assert.doesNotMatch(summary.bullets.join(' '), /cubic-interp/);

let report = context.mfBuildReadinessReportText({});
assert.match(report, /Final inter-sample peak: -1\.07 dBTP/);
assert.match(report, /Peak evidence: 4× polyphase FIR/);
assert.doesNotMatch(report, /^- True peak:/m);

context.mfUpdateMasterCopy();
assert.match(masterCopy, /final 4× inter-sample peak check/);
assert.doesNotMatch(masterCopy, /cubic-interp/);

context.state.masterConstraint = {
  truePeakDb: -1.55,
  truePeakCeilingDb: -1,
  truePeakMethod: 'cubic-fallback',
  truePeakStandardsDerived: false,
  truePeakSafetyPadDb: 0.55,
  truePeakSafetyTrimDb: -0.75,
};
summary = context.mfPlainWhatChanged({}, {}, {}, 'quick', {});
assert.match(summary.bullets[2], /cubic fallback with 0\.55 dB extra headroom/);
assert.match(summary.bullets[2], /not equivalent to the 4× check/);
report = context.mfBuildReadinessReportText({});
assert.match(report, /Peak evidence: cubic fallback with 0\.55 dB extra headroom/);

context.state.masterConstraint = {};
summary = context.mfPlainWhatChanged({}, {}, {}, 'quick', {});
assert.match(summary.bullets[2], /Final inter-sample peak evidence is unavailable/);

console.log('MixForge evidence-language smoke tests passed');
