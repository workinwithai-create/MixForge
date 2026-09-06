'use strict';

// DOM integrity guard for the Forensic rebuild path.
// Some stem cards contain nested `.actions` blocks (for example Vocal Layer
// Cleanup audition controls). The sequential mixer historically searched the
// whole stem panel for `.actions` and could therefore hand insertBefore() a
// nested descendant instead of the panel's direct rebuild-actions child.
(function installStemPanelDomIntegrity() {
  if (typeof rebuildCorrectedMix !== 'function') return;

  const previousRebuildCorrectedMix = rebuildCorrectedMix;

  function directActionChild(panel) {
    if (!panel?.children) return null;
    return Array.from(panel.children).find((node) => node?.classList?.contains('actions')) || null;
  }

  function nestedActionNodes(panel) {
    if (!panel?.querySelectorAll) return [];
    return Array.from(panel.querySelectorAll('.actions')).filter((node) => node?.parentElement !== panel);
  }

  rebuildCorrectedMix = async function rebuildCorrectedMixWithDomIntegrity(...args) {
    const panel = typeof $ === 'function' ? $('stemPanel') : null;
    const directAction = directActionChild(panel);
    if (!panel || !directAction) return previousRebuildCorrectedMix(...args);

    // The sequential mix module must remain free to use its existing direct
    // `.actions` anchor. Temporarily hide only nested action-class matches so a
    // descendant can never be mistaken for an insertBefore reference child.
    const nested = nestedActionNodes(panel).filter((node) => node.classList?.contains('actions'));
    for (const node of nested) node.classList.remove('actions');

    try {
      return await previousRebuildCorrectedMix(...args);
    } finally {
      for (const node of nested) node.classList.add('actions');
    }
  };

  globalThis.mixForgeDomIntegrity = {
    directActionChild,
    nestedActionNodes,
  };
})();
