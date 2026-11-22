'use strict';

// Steps layout: shows MixForge's panels one at a time behind a step switch, the way MixDoctor does,
// in place of one long page. It only decides which panel is on screen. Every panel, button and id
// stays in the page and works as before, and the rest of the app does not know this file exists.
//
// A step is "reached" once the app has revealed its panel (removed the `hidden` class). Steps that
// are not reached yet are dimmed. When the app scrolls to something inside a panel, that is the app
// saying "look here", so the switch moves to that panel first.
//
// Add ?steps=0 to the address to get the old stacked page back.

const MF_STEPS = [
  { key: 'load', label: 'Load', panel: 'loadPanel' },
  { key: 'diagnose', label: 'Diagnose', panel: 'auditPanel' },
  { key: 'stems', label: 'Stems', panel: 'stemPanel' },
  { key: 'vocals', label: 'Vocals', panel: 'vocalPanel' },
  { key: 'master', label: 'Master', panel: 'masterPanel' },
  { key: 'verify', label: 'Verify', panel: 'verifyPanel' },
];

// Which step to show, given what is reached. Pure, so it can be tested without a page.
//   wanted:  the step asked for (or null)
//   reached: { load: true, diagnose: false, ... }
function mfStepsResolve(wanted, reached, steps = MF_STEPS) {
  if (wanted && reached[wanted]) return wanted;
  const order = steps.map((step) => step.key);
  // Fall back to the furthest reached step at or before the wanted one, else the furthest reached at all.
  const upTo = wanted ? order.indexOf(wanted) : order.length - 1;
  for (let i = Math.min(upTo, order.length - 1); i >= 0; i -= 1) if (reached[order[i]]) return order[i];
  for (let i = order.length - 1; i >= 0; i -= 1) if (reached[order[i]]) return order[i];
  return order[0];
}

(function mfStepsBoot() {
  if (typeof document === 'undefined') return;
  let off = false;
  try { off = new URLSearchParams(window.location.search).get('steps') === '0'; } catch { off = false; }
  if (off) return;

  const steps = MF_STEPS.filter((step) => document.getElementById(step.panel));
  if (steps.length < 2 || document.getElementById('mfSteps')) return;
  const panelOf = (step) => document.getElementById(step.panel);
  const reachedMap = () => Object.fromEntries(steps.map((step) => [step.key, !panelOf(step).classList.contains('hidden')]));

  const nav = document.createElement('nav');
  nav.id = 'mfSteps';
  nav.className = 'mf-steps';
  nav.setAttribute('aria-label', 'Steps');
  const buttons = {};
  for (const step of steps) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.step = step.key;
    button.textContent = step.label;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => show(step.key, { scroll: true }));
    buttons[step.key] = button;
    nav.append(button);
    panelOf(step).dataset.step = step.key;
  }
  // Right under the header, so the switch is near the top of the page on a phone.
  const header = document.querySelector('header.hero');
  if (header) header.after(nav); else panelOf(steps[0]).before(nav);
  document.body.classList.add('mf-steps-on');

  let current = null;
  function paint() {
    const reached = reachedMap();
    for (const step of steps) {
      const on = step.key === current;
      buttons[step.key].disabled = !reached[step.key];
      buttons[step.key].setAttribute('aria-pressed', on ? 'true' : 'false');
      panelOf(step).classList.toggle('mf-step-on', on);
    }
    document.body.dataset.step = current;
  }
  function show(key, { scroll = false } = {}) {
    const next = mfStepsResolve(key, reachedMap(), steps);
    const changed = next !== current;
    current = next;
    paint();
    if (scroll && changed) nativeScroll.call(nav, { behavior: 'auto', block: 'start' });
    return changed;
  }

  // The app calls scrollIntoView on a panel, or on something inside one, to move the user along.
  // Show that panel first, otherwise there is nothing on screen to scroll to.
  const nativeScroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function mfStepsScrollIntoView(...args) {
    try {
      const panel = this.closest?.('.panel[data-step]');
      if (panel && document.body.classList.contains('mf-steps-on')) show(panel.dataset.step);
    } catch { /* never block the scroll itself */ }
    return nativeScroll.apply(this, args);
  };

  // Keep the dimmed/lit state in step with the app, and leave a step if the app hides its panel
  // (loading a new song hides everything after Load).
  const observer = new MutationObserver(() => {
    const reached = reachedMap();
    if (!reached[current]) show(current);
    else paint();
  });
  for (const step of steps) observer.observe(panelOf(step), { attributes: true, attributeFilter: ['class'] });

  show(steps[0].key);
})();

if (typeof module !== 'undefined') module.exports = { MF_STEPS, mfStepsResolve };
