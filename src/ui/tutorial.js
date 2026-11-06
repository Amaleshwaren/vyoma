// the commander's tutorial: a speech bubble with a portrait, plus a spotlight on the thing to tap.
// it only watches what the player does (through the bus) and never changes the game state.
// all text and steps live in data/tutorial.json.
import { bus } from '../bus.js';
import { previewPower } from '../sim/sim.js';

const DONE_KEY = 'vyoma-tutorial-done';

export function tutorialDone() {
  try {
    return localStorage.getItem(DONE_KEY) === '1';
  } catch {
    return false; // private browsing etc.: just show it
  }
}

export function initTutorial({ controller, data }) {
  const cfg = data.tutorial;
  const $ = (id) => document.getElementById(id);
  const steps = cfg.steps;
  let i = -1;
  let mode = 'off'; // 'off' | 'steps' | 'tip'
  let flags = {}; // things that happened since the current step appeared
  const tipsShown = new Set();

  // ---------- conditions ----------

  function met(cond) {
    if (!cond || !controller.state) return false;
    const s = controller.state;
    switch (cond.type) {
      case 'shopOpen':
        return Boolean(flags.shopOpen);
      case 'placing':
        return flags.placing === cond.building;
      case 'hasBuilding':
        return s.buildings.some((b) => b.type === cond.building);
      case 'power': {
        const p = previewPower(s, data);
        return p.produced - p.demand >= cond.min;
      }
      case 'roverOut':
        return s.rovers.some((r) => r.job);
      case 'phase':
        return controller.phase === cond.phase;
      case 'report':
        return Boolean(flags.report);
      default:
        return false;
    }
  }

  // ---------- the bubble ----------

  function portrait(mood) {
    const p = cfg.commander.portraits[mood] ?? cfg.commander.portraits.neutral;
    // an emoji placeholder until the art arrives; an image path once it does
    return /[./]/.test(p) ? `<img src="${p}" alt="${cfg.commander.name}">` : `<span>${p}</span>`;
  }

  function render({ mood, text, target, button, canSkip }) {
    $('cmd-portrait').className = `mood-${mood ?? 'neutral'}`;
    $('cmd-portrait').innerHTML = portrait(mood);
    $('cmd-name').textContent = cfg.commander.name;
    $('cmd-text').textContent = text;
    $('cmd-next').textContent = button ?? '';
    $('cmd-next').classList.toggle('hidden', !button);
    $('cmd-skip').classList.toggle('hidden', !canSkip);
    $('commander').classList.remove('hidden');
    spotlightTarget = target ?? null;
  }

  function hide() {
    $('commander').classList.add('hidden');
    $('spotlight').classList.add('hidden');
    spotlightTarget = null;
  }

  // ---------- step flow ----------

  function showStep() {
    const st = steps[i];
    flags = {};
    const last = i === steps.length - 1;
    render({ mood: st.mood, text: st.text, target: st.target, button: st.next ? (last ? "Let's go" : 'Next') : null, canSkip: !last });
  }

  function advance() {
    i += 1;
    while (i < steps.length && met(steps[i].skipIf)) i += 1;
    if (i >= steps.length) return finish();
    showStep();
  }

  function finish() {
    mode = 'off';
    hide();
    try {
      localStorage.setItem(DONE_KEY, '1');
    } catch {
      /* ignore */
    }
  }

  function check() {
    if (mode !== 'steps') return;
    const st = steps[i];
    if (st?.until && met(st.until)) advance();
  }

  function tip(key) {
    if (mode === 'steps' || tipsShown.has(key) || !cfg.tips[key]) return;
    tipsShown.add(key);
    mode = 'tip';
    render({ ...cfg.tips[key], target: null, button: 'Got it', canSkip: false });
  }

  $('cmd-next').addEventListener('click', () => {
    if (mode === 'tip') {
      mode = 'off';
      return hide();
    }
    advance();
  });
  $('cmd-skip').addEventListener('click', finish);

  // ---------- listening ----------

  bus.on('shop-open', () => {
    flags.shopOpen = true;
    check();
  });
  bus.on('select-building', (type) => {
    flags.placing = type;
    check();
  });
  bus.on('sol-report', () => {
    flags.report = true;
    check();
  });
  bus.on('state', check);
  bus.on('phase', check);
  bus.on('decision', () => tip('decision'));
  bus.on('ended', () => tip('ended'));

  // ---------- spotlight follows its target (things move and resize) ----------

  let spotlightTarget = null;
  (function follow() {
    const el = spotlightTarget ? document.querySelector(spotlightTarget) : null;
    const box = el?.getBoundingClientRect();
    const visible = box && box.width > 0 && box.height > 0;
    $('spotlight').classList.toggle('hidden', !visible);
    if (visible) {
      Object.assign($('spotlight').style, {
        left: `${box.left - 6}px`,
        top: `${box.top - 6}px`,
        width: `${box.width + 12}px`,
        height: `${box.height + 12}px`,
      });
    }
    requestAnimationFrame(follow);
  })();

  return {
    start() {
      tipsShown.clear();
      mode = 'steps';
      i = -1;
      advance();
    },
    stop() {
      mode = 'off';
      hide();
    },
  };
}