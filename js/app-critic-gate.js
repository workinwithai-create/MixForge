'use strict';

// MixForge Critic Gate research preview.
// Turns the sequential engine's bounded correction attempts into inspectable,
// copyable receipts. It never changes audio or overrides the engine's verdict.
(function installCriticGate() {
  const VERSION = 'mixagent-pattern-v1';
  const finite = (value) => value !== null && value !== '' && Number.isFinite(Number(value));
  const rounded = (value, digits = 3) => finite(value) ? Number(Number(value).toFixed(digits)) : null;

  function operationChanges(operation, index) {
    const label = operation?.label || operation?.type || ('operation ' + (index + 1));
    const units = {
      gain: 'dB', gainDb: 'dB', frequency: 'Hz', threshold: 'dB',
      ratio: ':1', attack: 'seconds', release: 'seconds', knee: 'dB', q: 'Q',
    };
    const keys = ['gain', 'gainDb', 'frequency', 'q', 'threshold', 'ratio', 'attack', 'release', 'knee'];
    return keys
      .filter((key) => finite(operation?.[key]))
      .map((key) => ({
        label,
        parameter: (operation.type || 'processor') + '.' + key,
        before: key === 'gain' || key === 'gainDb' ? 0 : null,
        proposed: rounded(operation[key]),
        unit: units[key] || '',
      }));
  }

  function statusFor(stage) {
    if (stage?.reverted) return 'rejected';
    if (stage?.backedOff) return 'accepted-reduced';
    if (stage?.applied) return 'accepted';
    return 'held';
  }

  function reasonFor(stage, status) {
    if (status === 'rejected') {
      const last = stage.attempts?.[stage.attempts.length - 1];
      return last?.problems?.length
        ? 'Rejected after retry: ' + last.problems.join('; ')
        : 'Rejected because the correction did not pass the measurement gate.';
    }
    if (status === 'accepted-reduced') {
      const first = stage.attempts?.[0];
      return 'Accepted at half strength' + (first?.problems?.length
        ? ' after the full move caused: ' + first.problems.join('; ')
        : '.');
    }
    if (status === 'accepted') return 'Accepted because no guarded measurement regressed.';
    return 'Held unchanged because the current mix did not justify a correction.';
  }

  function buildReceipt(stage, plan) {
    const proposal = stage?.proposed || stage?.decision || {};
    const operations = proposal.operations || [];
    const changes = operations.flatMap(operationChanges);

    if (finite(proposal.trimDb) && Math.abs(Number(proposal.trimDb)) >= 0.05) {
      changes.push({
        label: 'Stage level trim',
        parameter: 'stage.trimDb',
        before: 0,
        proposed: rounded(proposal.trimDb),
        unit: 'dB',
      });
    }
    if (changes.length && finite(proposal.wet)) {
      changes.push({
        label: 'Bounded blend',
        parameter: 'stage.wet',
        before: 0,
        proposed: rounded(proposal.wet),
        unit: '0–1',
      });
    }

    const status = statusFor(stage);
    return {
      schemaVersion: VERSION,
      id: 'stage-' + stage.index + '-' + stage.stem,
      target: stage.stem,
      role: stage.role || stage.stem,
      anchor: plan?.anchor || null,
      problem: proposal.heard || 'No measured problem recorded.',
      proposedChanges: changes,
      confidence: {
        state: stage.source?.state || 'unknown',
        label: stage.source?.label || 'Unknown',
        separationScore: rounded(stage.source?.score, 1),
        anchorBleedEstimate: rounded(stage.source?.bleed, 3),
      },
      measurements: {
        loudnessLufs: {
          before: rounded(stage.before?.lufs),
          after: rounded(stage.after?.lufs),
          delta: rounded(stage.delta?.lufs),
        },
        peakDb: {
          before: rounded(stage.before?.peakDb),
          after: rounded(stage.after?.peakDb),
          delta: finite(stage.before?.peakDb) && finite(stage.after?.peakDb)
            ? rounded(stage.after.peakDb - stage.before.peakDb)
            : null,
        },
        monoCorrelation: {
          before: rounded(stage.before?.correlation),
          after: rounded(stage.after?.correlation),
          delta: rounded(stage.delta?.correlation),
        },
        leadMarginDb: {
          before: rounded(stage.marginBefore),
          after: rounded(stage.marginAfter),
          delta: rounded(stage.delta?.margin),
        },
        lowMidChangeDb: rounded(stage.delta?.mud),
      },
      verdict: {
        status,
        reason: reasonFor(stage, status),
        attempts: (stage.attempts || []).map((attempt) => ({
          strength: rounded(attempt.factor),
          passed: !(attempt.problems || []).length,
          problems: [...(attempt.problems || [])],
        })),
      },
      audit: {
        originalPreserved: true,
        rollbackPoint: 'untouched-original',
        listenFor: proposal.listenFor || '',
      },
    };
  }

  function validateReceipt(receipt) {
    const errors = [];
    if (!receipt?.id) errors.push('missing id');
    if (!receipt?.target) errors.push('missing target');
    if (!receipt?.problem) errors.push('missing problem');
    if (!receipt?.verdict?.status) errors.push('missing verdict');
    for (const change of receipt?.proposedChanges || []) {
      if (!change.parameter) errors.push('change missing parameter');
      if (!finite(change.proposed)) errors.push((change.parameter || 'change') + ' missing numeric proposal');
    }
    return { valid: errors.length === 0, errors };
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function metricLine(receipt) {
    const m = receipt.measurements;
    const bits = [];
    if (finite(m.leadMarginDb.before) && finite(m.leadMarginDb.after)) {
      bits.push('lead margin ' + m.leadMarginDb.before + ' → ' + m.leadMarginDb.after + ' dB');
    }
    if (finite(m.loudnessLufs.delta)) bits.push('Δ loudness ' + m.loudnessLufs.delta + ' LU');
    if (finite(m.peakDb.delta)) bits.push('Δ peak ' + m.peakDb.delta + ' dB');
    if (finite(m.monoCorrelation.delta)) bits.push('Δ mono ' + m.monoCorrelation.delta);
    return bits.join(' · ') || 'No guarded measurement changed.';
  }

  function changeLine(change) {
    const before = change.before == null ? '' : ' from ' + change.before;
    return change.label + ': ' + change.parameter + before + ' → ' + change.proposed + (change.unit ? ' ' + change.unit : '');
  }

  function render(receipts) {
    if (typeof document === 'undefined') return receipts;
    const log = typeof globalThis.$ === 'function' ? globalThis.$('mixStageLog') : document.getElementById('mixStageLog');
    const panel = typeof globalThis.$ === 'function' ? globalThis.$('stemPanel') : document.getElementById('stemPanel');
    if (!log || !panel) return receipts;

    let root = document.getElementById('criticGatePanel');
    if (!root) {
      root = node('section', 'forensic-block critic-gate');
      root.id = 'criticGatePanel';
      if (log.nextSibling) panel.insertBefore(root, log.nextSibling);
      else panel.append(root);
    }
    root.replaceChildren();
    root.append(node('h3', '', 'Correction receipts · research preview'));
    root.append(node('p', 'stem-guidance',
      'Each proposed premaster move must name the problem, expose numeric settings, survive before/after measurements, and retain the untouched original as rollback. This view does not change audio.'));

    const actions = node('div', 'actions critic-gate-actions');
    const copy = node('button', 'secondary', 'Copy receipts as JSON');
    copy.type = 'button';
    const status = node('span', 'critic-copy-status', '');
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(receipts, null, 2));
        status.textContent = 'Copied';
      } catch (_) {
        status.textContent = 'Copy unavailable — use browser developer tools.';
      }
    };
    actions.append(copy, status);
    root.append(actions);

    const grid = node('div', 'critic-gate-grid');
    for (const receipt of receipts) {
      const card = node('article', 'critic-receipt ' + receipt.verdict.status);
      const top = node('div', 'critic-receipt-top');
      top.append(
        node('h4', '', 'Stage ' + receipt.id.split('-')[1] + ' · ' + receipt.target),
        node('span', 'badge critic-verdict', receipt.verdict.status.replace('-', ' '))
      );
      card.append(top);
      card.append(node('p', '', 'Problem: ' + receipt.problem));
      if (receipt.proposedChanges.length) {
        const list = node('ul', 'critic-change-list');
        for (const change of receipt.proposedChanges) list.append(node('li', '', changeLine(change)));
        card.append(list);
      } else {
        card.append(node('p', 'guardrail', 'No parameter change proposed.'));
      }
      card.append(node('p', 'critic-measurements', metricLine(receipt)));
      card.append(node('p', 'consequence', receipt.verdict.reason));
      card.append(node('small', 'guardrail',
        'Confidence: ' + receipt.confidence.label + ' · rollback: untouched original'));
      grid.append(card);
    }
    root.append(grid);
    return receipts;
  }

  function renderStages(stages, context = {}) {
    const receipts = (stages || []).map((stage) => buildReceipt(stage, context.plan));
    for (const receipt of receipts) {
      const result = validateReceipt(receipt);
      receipt.validation = result;
    }
    globalThis.mixForgeCriticGate = {
      version: VERSION,
      receipts,
      buildReceipt,
      validateReceipt,
      renderStages,
    };
    return render(receipts);
  }

  globalThis.mfCriticGateBuildReceipt = buildReceipt;
  globalThis.mfCriticGateValidateReceipt = validateReceipt;
  globalThis.mfCriticGateRender = renderStages;
  globalThis.mixForgeCriticGate = {
    version: VERSION,
    receipts: [],
    buildReceipt,
    validateReceipt,
    renderStages,
  };
})();
