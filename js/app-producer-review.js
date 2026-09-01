'use strict';

// MixForge Producer's Ear presentation layer.
// The listening model writes the musician-facing review. Measurements and
// forensic findings remain available underneath as supporting evidence.

const MF_PRODUCER_VOICE = 'Charon';

function mfPlainProducerFix(finding) {
  const text = `${finding?.problem || ''} ${finding?.evidence || ''}`.toLowerCase();
  if (/clip|overload/.test(text)) return {
    title: 'Get me a cleaner bounce first',
    why: 'The mix is already hitting the ceiling, so any master we add will make the rough edge more obvious.',
    move: 'Back the mix bus or limiter down and export a clean pre-limiter version before we push it any further.',
  };
  if (/mono|correlation|phase/.test(text)) return {
    title: 'Make sure the width survives in mono',
    why: 'Some of the wide information can thin out or disappear on a phone, smart speaker, or club system.',
    move: 'Check the wide instruments and ambience in mono before adding any more stereo spread.',
  };
  if (/low.mid|mud|congestion/.test(text)) return {
    title: 'Open up the middle of the mix',
    why: 'Too much body is stacking in the same place, which makes the important parts feel farther away.',
    move: 'Separate the vocal and the residual instruments, then clear space at the source instead of thinning the whole song.',
  };
  if (/lead|vocal|mask/.test(text)) return {
    title: 'Keep the lead emotionally in front',
    why: 'The lead can lose words and presence when the rest of the track fills out.',
    move: 'Check the vocal against the instruments and create space around it before reaching for more compression.',
  };
  if (/sub|bass/.test(text)) return {
    title: 'Tighten the bottom before mastering',
    why: 'The deepest low end is using headroom without giving the song more impact.',
    move: 'Inspect the bass source first and trim only the energy that is not helping the groove.',
  };
  if (/sibil|high.frequency|harsh|flare/.test(text)) return {
    title: 'Calm the sharp moments, not the whole top end',
    why: 'A few bright hits can pull attention away from the song and get tiring at release volume.',
    move: 'Find which source creates those moments and control only those hits so the mix keeps its air.',
  };
  if (/crest|over.control|dynamics/.test(text)) return {
    title: 'Do not squeeze out what is left of the movement',
    why: 'The mix is already controlled, and more compression could flatten the punch and emotion.',
    move: 'Skip extra mastering compression and work from a less-limited bounce if the A/B feels pinned down.',
  };
  return {
    title: String(finding?.problem || 'Fix the biggest balance issue first'),
    why: String(finding?.consequence || 'This is the issue most likely to keep the mix from translating clearly.'),
    move: String(finding?.nextTest || finding?.action || 'Make one conservative change, then compare it against the untouched mix.'),
  };
}

function mfBuildFallbackProducerReview(audit, metrics) {
  const findings = Array.isArray(audit?.findings) ? audit.findings : [];
  const good = [];
  if (metrics && metrics.clipPercent <= 0.001 && metrics.peakDb <= -0.1) good.push('The file has usable headroom and no obvious digital overload holding it back.');
  if (metrics && metrics.correlation >= 0.35) good.push('The stereo picture should hold together without the sides fighting the center.');
  if (metrics && metrics.crestDb >= 9) good.push('There is still some punch and breathing room left to protect in the master.');
  if (!good.length) good.push('There is still a workable musical foundation here; the next move is fixing the few things that are masking it.');
  const fixes = [...findings]
    .sort((a, b) => ({ high: 3, medium: 2, low: 1 }[b.severity] || 0) - ({ high: 3, medium: 2, low: 1 }[a.severity] || 0))
    .slice(0, 3)
    .map(mfPlainProducerFix);
  return {
    opening: findings.length
      ? 'Alright — there is a solid mix underneath this, but a few balance problems are keeping it from landing as confidently as it should.'
      : 'Alright — this is in good shape. I am not seeing a major mix problem that needs to stop you from hearing a conservative master.',
    whatsWorking: good.slice(0, 3),
    honestTake: findings.length
      ? `I would not call it finished yet. The song does not need a pile of processing; it needs ${fixes.length === 1 ? 'one focused correction' : 'a few focused corrections'} before the master can do its job.`
      : 'I would move this straight to a careful A/B master. The goal now is polish and translation, not changing the personality of the mix.',
    fixFirst: fixes,
    protect: metrics?.crestDb >= 9
      ? 'Protect the punch and natural rise-and-fall that are still in the mix. Do not trade that movement for loudness.'
      : 'Protect the tone and emotion that already feel believable. Every repair should leave the song sounding like itself.',
    source: 'measured',
  };
}

function mfProducerReviewScript(review) {
  if (!review) return '';
  const parts = [
    'Alright, here is my producer review.',
    review.opening,
    review.whatsWorking?.length ? `First, what is working. ${review.whatsWorking.join(' ')}` : '',
    review.honestTake ? `My honest take. ${review.honestTake}` : '',
  ];
  for (let index = 0; index < (review.fixFirst || []).length; index += 1) {
    const fix = review.fixFirst[index];
    parts.push(`${index === 0 ? 'The first thing I would fix' : `Next, number ${index + 1}`}: ${fix.title}. ${fix.why} What I would do: ${fix.move}`);
  }
  if (review.protect) parts.push(`And this is what I would protect: ${review.protect}`);
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 3900);
}

function mfProducerEl(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function mfRenderProducerReview(audit, metrics) {
  const root = $('producerReview');
  if (!root) return;
  const review = audit?.producerReview || mfBuildFallbackProducerReview(audit, metrics);
  state.producerReview = review;
  const script = mfProducerReviewScript(review);
  if (state.producerReviewScript !== script) mfStopProducerVoice(true);
  state.producerReviewScript = script;
  root.replaceChildren();

  const header = mfProducerEl('div', 'producer-review-head');
  const title = mfProducerEl('div');
  title.append(
    mfProducerEl('span', 'producer-kicker', "Producer's Ear"),
    mfProducerEl('h3', '', 'Here’s what I’m hearing'),
  );
  const source = mfProducerEl('span', `producer-source ${review.source === 'listening' ? 'heard' : 'measured'}`, review.source === 'listening' ? 'Listening + measurements' : 'Measurements only');
  header.append(title, source);
  root.append(header);
  root.append(mfProducerEl('p', 'producer-scope', review.source === 'listening'
    ? 'I listened closely to the strongest and most problem-prone sections, then checked that impression against the measured mix.'
    : 'The listening pass was unavailable, so this plain-language review is based on the measured mix only.'));
  if (review.opening) root.append(mfProducerEl('p', 'producer-opening', review.opening));

  if (review.whatsWorking?.length) {
    const section = mfProducerEl('section', 'producer-section working');
    section.append(mfProducerEl('h4', '', 'What’s working'));
    const list = mfProducerEl('ul', 'producer-working-list');
    for (const item of review.whatsWorking) list.append(mfProducerEl('li', '', item));
    section.append(list);
    root.append(section);
  }

  if (review.honestTake) {
    const section = mfProducerEl('section', 'producer-section honest');
    section.append(mfProducerEl('h4', '', 'My honest take'), mfProducerEl('p', '', review.honestTake));
    root.append(section);
  }

  if (review.fixFirst?.length) {
    const section = mfProducerEl('section', 'producer-section fixes');
    section.append(mfProducerEl('h4', '', 'What I’d fix first'));
    const list = mfProducerEl('div', 'producer-fix-list');
    review.fixFirst.forEach((fix, index) => {
      const card = mfProducerEl('article', 'producer-fix');
      card.append(mfProducerEl('span', 'producer-fix-number', String(index + 1)));
      const copy = mfProducerEl('div');
      copy.append(mfProducerEl('h5', '', fix.title), mfProducerEl('p', '', fix.why), mfProducerEl('p', 'producer-move', `What I’d do: ${fix.move}`));
      card.append(copy);
      list.append(card);
    });
    section.append(list);
    root.append(section);
  }

  if (review.protect) {
    const protect = mfProducerEl('section', 'producer-protect');
    protect.append(mfProducerEl('span', '', 'The thing I’d protect'), mfProducerEl('p', '', review.protect));
    root.append(protect);
  }

  const voice = mfProducerEl('div', 'producer-voice');
  const button = mfProducerEl('button', 'producer-voice-btn', '▶ Hear producer feedback');
  button.id = 'producerVoiceBtn';
  button.type = 'button';
  button.disabled = !script;
  button.addEventListener('click', () => void mfToggleProducerVoice());
  const status = mfProducerEl('span', 'producer-voice-status', 'Spoken in the same Producer’s Ear voice used by Release Forge.');
  status.id = 'producerVoiceStatus';
  voice.append(button, status);
  root.append(voice);
}

function mfBase64AudioUrl(audioB64, mimeType = 'audio/wav') {
  const binary = atob(audioB64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

function mfSetProducerVoiceUi(label, status, busy = false) {
  const button = $('producerVoiceBtn');
  if (button) {
    button.textContent = label;
    button.disabled = busy || !state.producerReviewScript;
    button.setAttribute('aria-pressed', state.producerReviewPlaying ? 'true' : 'false');
  }
  if ($('producerVoiceStatus')) $('producerVoiceStatus').textContent = status;
}

function mfStopProducerVoice(clear = false) {
  if (state.producerReviewAudio) {
    state.producerReviewAudio.pause();
    if (clear) state.producerReviewAudio.removeAttribute('src');
  }
  if (clear && state.producerReviewAudioUrl) URL.revokeObjectURL(state.producerReviewAudioUrl);
  if (clear) {
    state.producerReviewAudio = null;
    state.producerReviewAudioUrl = null;
  }
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  state.producerReviewPlaying = false;
}

function mfSpeakWithDevice(script) {
  if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return false;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(script);
  utterance.rate = 0.94;
  utterance.pitch = 0.9;
  utterance.onend = () => {
    state.producerReviewPlaying = false;
    mfSetProducerVoiceUi('▶ Hear producer feedback', 'Finished. Tap to hear it again.');
  };
  utterance.onerror = () => {
    state.producerReviewPlaying = false;
    mfSetProducerVoiceUi('▶ Try producer voice again', 'Spoken review is unavailable right now.');
  };
  state.producerReviewPlaying = true;
  speechSynthesis.speak(utterance);
  mfSetProducerVoiceUi('Ⅱ Pause producer feedback', 'Studio voice was unavailable, so your device voice is reading the review.');
  return true;
}

async function mfToggleProducerVoice() {
  const script = state.producerReviewScript;
  if (!script) return;
  if (state.producerReviewPlaying) {
    mfStopProducerVoice(false);
    mfSetProducerVoiceUi('▶ Resume producer feedback', 'Paused.');
    return;
  }
  if (typeof stopPreview === 'function') stopPreview();
  if (state.producerReviewAudio) {
    await state.producerReviewAudio.play();
    state.producerReviewPlaying = true;
    mfSetProducerVoiceUi('Ⅱ Pause producer feedback', 'Playing your producer review…');
    return;
  }
  mfSetProducerVoiceUi('Loading producer voice…', 'Turning the review into a natural spoken response…', true);
  try {
    const response = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script, voiceName: MF_PRODUCER_VOICE }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !data.audioB64) throw new Error(data.error || 'Producer voice unavailable');
    const url = mfBase64AudioUrl(data.audioB64, data.mimeType || 'audio/wav');
    const audio = new Audio(url);
    state.producerReviewAudio = audio;
    state.producerReviewAudioUrl = url;
    audio.onended = () => {
      state.producerReviewPlaying = false;
      audio.currentTime = 0;
      mfSetProducerVoiceUi('▶ Hear producer feedback', 'Finished. Tap to hear it again.');
    };
    audio.onpause = () => {
      if (!audio.ended) state.producerReviewPlaying = false;
    };
    audio.onerror = () => {
      state.producerReviewPlaying = false;
      mfSetProducerVoiceUi('▶ Try producer voice again', 'The spoken audio could not be played.');
    };
    await audio.play();
    state.producerReviewPlaying = true;
    mfSetProducerVoiceUi('Ⅱ Pause producer feedback', 'Playing your producer review…');
  } catch (error) {
    console.warn('MixForge producer voice unavailable:', error);
    if (!mfSpeakWithDevice(script)) mfSetProducerVoiceUi('▶ Try producer voice again', 'Spoken review is unavailable right now.');
  }
}

function mfInstallProducerReview() {
  if (typeof renderAudit !== 'function' || typeof state === 'undefined') return;
  const previousRenderAudit = renderAudit;
  renderAudit = function renderAuditWithProducerReview(audit, metrics) {
    previousRenderAudit(audit, metrics);
    mfRenderProducerReview(state.audit || audit, metrics);
  };
  const previousResetResults = resetResults;
  resetResults = function resetResultsWithProducerReview(...args) {
    mfStopProducerVoice(true);
    state.producerReview = null;
    state.producerReviewScript = '';
    if ($('producerReview')) $('producerReview').replaceChildren();
    return previousResetResults(...args);
  };
}

if (typeof globalThis !== 'undefined') {
  globalThis.mfBuildFallbackProducerReview = mfBuildFallbackProducerReview;
  globalThis.mfProducerReviewScript = mfProducerReviewScript;
  globalThis.mfPlainProducerFix = mfPlainProducerFix;
}

if (typeof document !== 'undefined' && typeof $ === 'function') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mfInstallProducerReview);
  else mfInstallProducerReview();
}
