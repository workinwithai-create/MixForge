'use strict';

// MixForge 2.5 listening merge.
// Measurements stay ground truth for clip %, LUFS, sample peak, correlation, DC.
// Gemini may add mix/master hypotheses after hearing a compact excerpt.
// It must not judge vocal performance (AuraMix) or invent frequencies.

const MF_CANONICAL_STEMS = ['vocals', 'bass', 'drums', 'other'];
const MF_STEM_ALIAS_MAP = { guitars: 'other', keys: 'other' };
const MF_ALLOWED_HZ = new Set([20, 60, 250, 500, 2000, 5000, 16000]);
const MF_PERFORMANCE_CLAIM = /pitch|intonation|timing|out of tune|late take|vocal take|performance quality|singer skill|wrong notes|lyrics are/i;

function normalizeAllowedStem(stem) {
  if (stem == null || stem === '') return null;
  const actual = MF_STEM_ALIAS_MAP[stem] || String(stem);
  return MF_CANONICAL_STEMS.includes(actual) ? actual : null;
}

function findingText(finding) {
  return `${finding?.problem || ''} ${finding?.evidence || ''} ${finding?.action || ''} ${finding?.nextTest || ''}`;
}

function factFamily(finding) {
  const text = findingText(finding).toLowerCase();
  if (/clip|overload/.test(text)) return 'clip';
  if (/dc offset/.test(text)) return 'dc';
  if (/mono compatibility|correlation/.test(text)) return 'mono';
  if (/crest|over-controlled|dynamics already/.test(text)) return 'dynamics';
  if (/\blufs\b|loudness/.test(text)) return 'loudness';
  return null;
}

function findingFingerprint(finding) {
  return String(finding?.problem || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function similarFinding(left, right) {
  const family = factFamily(left);
  if (family && family === factFamily(right)) return true;
  const a = findingFingerprint(left);
  const b = findingFingerprint(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const wordsA = new Set(a.split(' ').filter((word) => word.length > 3));
  const wordsB = new Set(b.split(' ').filter((word) => word.length > 3));
  let overlap = 0;
  for (const word of wordsA) if (wordsB.has(word)) overlap += 1;
  return overlap >= 2;
}

function inventsFrequency(finding) {
  const text = findingText(finding);
  const matches = text.matchAll(/(\d+(?:\.\d+)?)\s*(k?hz)/gi);
  for (const match of matches) {
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    const hz = /k/i.test(match[2]) ? value * 1000 : value;
    if (MF_ALLOWED_HZ.has(hz)) continue;
    return true;
  }
  return false;
}

function contradictsMeasuredFacts(finding, measuredFallback) {
  const text = findingText(finding).toLowerCase();
  const measured = Array.isArray(measuredFallback?.findings) ? measuredFallback.findings : [];
  const measuredClip = measured.some((item) => factFamily(item) === 'clip');
  const measuredMono = measured.some((item) => factFamily(item) === 'mono');
  if (measuredClip && /no clip|not clipped|clean(?:ly)? peaked|no overload|no distortion/.test(text)) return true;
  if (measuredMono && /mono.?safe|phase.?ok|no mono risk|good correlation/.test(text)) return true;
  return false;
}

function sanitizeAiCandidates(candidates) {
  if (!Array.isArray(candidates)) return undefined;
  const cleaned = [];
  for (const candidate of candidates.slice(0, 4)) {
    const stem = normalizeAllowedStem(candidate?.stem);
    if (!stem) continue;
    cleaned.push({
      stem,
      likelihood: clamp(Number(candidate.likelihood) || 50, 1, 98),
    });
  }
  return cleaned.length ? cleaned : undefined;
}

function sanitizeListeningFinding(raw, measuredFallback) {
  if (!raw || typeof raw !== 'object') return null;
  const finding = {
    severity: ['high', 'medium', 'low'].includes(raw.severity) ? raw.severity : 'medium',
    stage: raw.stage === 'master' ? 'master' : 'mix',
    problem: String(raw.problem || 'Mix issue').slice(0, 120),
    evidence: String(raw.evidence || '').slice(0, 400),
    action: String(raw.action || '').slice(0, 500),
    stem: normalizeAllowedStem(raw.stem),
    consequence: raw.consequence ? String(raw.consequence).slice(0, 300) : undefined,
    candidates: sanitizeAiCandidates(raw.candidates),
    nextTest: raw.nextTest ? String(raw.nextTest).slice(0, 400) : undefined,
    confidence: Number.isFinite(Number(raw.confidence)) ? clamp(Number(raw.confidence), 5, 98) : undefined,
    source: 'listening',
  };
  if (MF_PERFORMANCE_CLAIM.test(findingText(finding))) return null;
  if (inventsFrequency(finding)) return null;
  if (contradictsMeasuredFacts(finding, measuredFallback)) return null;
  return finding;
}

function mergeForensicAudit(aiValue, measuredFallback) {
  const measured = measuredFallback && typeof measuredFallback === 'object' ? measuredFallback : {
    readinessScore: 50,
    summary: 'No measured audit was available.',
    findings: [],
    stemsToInspect: [],
  };
  if (!aiValue || typeof aiValue !== 'object') {
    return {
      ...measured,
      listeningUsed: false,
      aiUsed: false,
      aiFindingsAdded: 0,
      listeningFindingsAdded: 0,
      aiNoteOnly: false,
    };
  }

  const measuredFindings = (Array.isArray(measured.findings) ? measured.findings : []).map((finding) => ({
    ...finding,
    stem: normalizeAllowedStem(finding.stem) || finding.stem || null,
    source: finding.source || 'measured',
  }));

  const added = [];
  for (const raw of (Array.isArray(aiValue.findings) ? aiValue.findings.slice(0, 12) : [])) {
    const finding = sanitizeListeningFinding(raw, measured);
    if (!finding) continue;
    if (measuredFindings.some((item) => similarFinding(item, finding))) continue;
    if (added.some((item) => similarFinding(item, finding))) continue;
    added.push(finding);
  }

  const measuredStems = (measured.stemsToInspect || []).map(normalizeAllowedStem).filter(Boolean);
  const aiStems = (Array.isArray(aiValue.stemsToInspect) ? aiValue.stemsToInspect : []).map(normalizeAllowedStem).filter(Boolean);
  const findingStems = [...measuredFindings, ...added].map((finding) => finding.stem).filter(Boolean);
  const stemsToInspect = [...new Set([...measuredStems, ...aiStems, ...findingStems])];

  const listeningSummary = String(aiValue.summary || '').trim();
  return {
    ...measured,
    summary: listeningSummary
      ? `${measured.summary} Listening note: ${listeningSummary.slice(0, 360)}`
      : measured.summary,
    readinessScore: measured.readinessScore,
    findings: [...measuredFindings, ...added].slice(0, 14),
    stemsToInspect: stemsToInspect.length ? stemsToInspect : (measured.stemsToInspect || []),
    listeningUsed: true,
    aiUsed: true,
    aiFindingsAdded: added.length,
    listeningFindingsAdded: added.length,
    aiNoteOnly: added.length === 0 && Boolean(listeningSummary),
  };
}

function auditCompleteStatusMessage(audit) {
  if (!audit?.listeningUsed && !audit?.aiUsed) {
    return 'Audit complete. Using measurements only.';
  }
  if ((audit.listeningFindingsAdded || audit.aiFindingsAdded || 0) > 0) {
    return 'Audit complete. Measurements kept as facts; Gemini listening pass added mix hypotheses.';
  }
  return 'Audit complete. Measurements kept as facts; listening pass added an engineer note.';
}

validateAudit = function validateForensicAudit(aiValue, measuredFallback) {
  return mergeForensicAudit(aiValue, measuredFallback);
};

if (typeof globalThis !== 'undefined') {
  globalThis.normalizeAllowedStem = normalizeAllowedStem;
  globalThis.mergeForensicAudit = mergeForensicAudit;
  globalThis.auditCompleteStatusMessage = auditCompleteStatusMessage;
}
