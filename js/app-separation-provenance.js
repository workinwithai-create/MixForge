'use strict';

// Keeps forensic copy aligned with the backend model that actually produced each stem.
// Loaded after app-forensics.js so it can decorate the existing renderer without
// duplicating the repair UI or changing current Demucs behavior.

(function installSeparationProvenanceUI() {
  if (typeof renderStemPlans !== 'function') return;

  const baseRenderStemPlans = renderStemPlans;

  function separatorInfo() {
    return state.separationInfo && typeof state.separationInfo === 'object'
      ? state.separationInfo
      : null;
  }

  function stemSource(stem) {
    const info = separatorInfo();
    const explicit = info?.stemSources?.[stem];
    if (explicit) return String(explicit).toLowerCase();
    const engine = String(info?.engine || 'demucs').toLowerCase();
    if (engine === 'melband' && stem === 'vocals') return 'melband';
    return 'demucs';
  }

  function measuredHeading(stem) {
    const source = stemSource(stem);
    if (source === 'melband') return 'Measured conditions on this MelBand RoFormer vocal stem';
    return 'Measured conditions on this isolated Demucs bucket';
  }

  function updatePanelProvenance() {
    const panel = $('stemPanel');
    if (!panel) return;
    const info = separatorInfo();
    const engine = String(info?.engine || 'demucs').toLowerCase();
    const title = panel.querySelector('.panel-title h2');
    const description = panel.querySelector('.panel-title p');

    if (!title || !description) return;

    if (engine === 'hybrid') {
      title.textContent = 'Isolated source stems and measured conditions';
      description.textContent = 'Quality routing used MelBand RoFormer for the vocal stem while Demucs remained authoritative for bass, drums, and residual other. Guitars/keys still share residual other and are not separately confirmed.';
      return;
    }

    if (engine === 'melband') {
      title.textContent = 'Isolated vocal stem and measured conditions';
      description.textContent = 'The vocal stem was isolated with MelBand RoFormer. MixForge reports only the source this model actually produced; it does not relabel the full instrumental mix as residual other.';
      return;
    }

    title.textContent = 'Isolated Demucs buckets and measured conditions';
    description.textContent = 'A heuristic leakage/fit score is graded before processing — not lab SDR. Demucs separates vocals, bass, drums, and residual other; guitars/keys share residual other. That is not instrument confirmation.';
  }

  renderStemPlans = function renderStemPlansWithProvenance() {
    baseRenderStemPlans();
    updatePanelProvenance();

    const cards = [...document.querySelectorAll('#stemGrid .stem-card')];
    const entries = Object.entries(state.stemPlans || {});
    cards.forEach((card, index) => {
      const stem = entries[index]?.[0];
      if (!stem) return;
      const heading = card.querySelector('.confirmation-list > b');
      if (heading) heading.textContent = measuredHeading(stem);
    });
  };
})();
