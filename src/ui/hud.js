// all the HTML on top of the game: sector picker, resource bar, sol controls, task panel,
// build menu, info card, toasts, daily report and debrief.
// it only reads state and calls controller methods; it never changes state directly.
import { bus } from '../bus.js';
import { costOf, getDef, getNodeDef, getSector, previewPower, planTrip, sizeOf } from '../sim/sim.js';
import { stormOn, repairCostOf } from '../sim/events.js';

const $ = (id) => document.getElementById(id);
const r1 = (n) => (Math.round(n * 10) / 10).toLocaleString('en-GB');
const signed = (n) => `${n >= 0 ? '+' : '−'}${r1(Math.abs(n))}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const consumerName = (data, id) => (id === 'rover' ? 'Rovers' : getDef(data, id).name);
const radiationWord = (m) => (m < 0.5 ? 'Very low' : m < 0.95 ? 'Low' : m <= 1.05 ? 'Average' : 'High');
const powerWord = (m) => (m < 0.5 ? 'Very weak' : m < 0.95 ? 'Weak' : m <= 1.05 ? 'Average' : 'Strong');

export function initHud({ controller, data, startGame }) {
  let selectedSector = null;
  let selectedBuilding = null;
  let inspectedNodeId = null;

  // ---------- sector picker ----------

  $('sector-grid').innerHTML = data.sectors
    .map((s) => `<button class="sector-btn" data-sector="${s.id}"><strong>${esc(s.name)}</strong><span>${esc(s.tagline)}</span></button>`)
    .join('');

  $('sector-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sector]');
    if (!btn) return;
    selectedSector = btn.dataset.sector;
    document.querySelectorAll('.sector-btn').forEach((b) => b.classList.toggle('active', b === btn));
    const s = getSector(data, selectedSector);
    $('sector-detail').innerHTML = `
      <h2>${esc(s.name)}</h2>
      <dl>
        <dt>Buildable land</dt><dd>${Math.round(s.buildableFraction * 100)}%</dd>
        <dt>Sunlight</dt><dd>${powerWord(s.solarMult)}</dd>
        <dt>Radiation</dt><dd>${radiationWord(s.radiationMult)}</dd>
        <dt>Good for</dt><dd>${s.strengths.map(esc).join(', ')}</dd>
        <dt>Short on</dt><dd>${s.scarcities.map(esc).join(', ')}</dd>
        <dt>Risk</dt><dd>${esc(s.risk)}</dd>
      </dl>
      <p class="science">${esc(s.scienceNote)}</p>`;
    $('land-btn').disabled = false;
  });

  $('land-btn').addEventListener('click', () => {
    if (!selectedSector) return;
    $('sector-picker').classList.add('hidden');
    $('debrief').classList.add('hidden');
    $('hud').classList.remove('hidden');
    startGame(selectedSector);
  });

  // ---------- sol controls ----------

  function renderControls() {
    const p = controller.phase;
    const next = controller.state ? controller.state.sol + 1 : 1;
    const html = {
      briefing: `<button class="primary" data-act="start">▶ Start sol ${next}</button>`,
      running: `<button data-act="pause">⏸ Pause</button><button class="primary" data-act="end">⏭ End sol</button>`,
      paused: `<button data-act="pause">▶ Resume</button><button class="primary" data-act="end">⏭ End sol</button>`,
      fastforward: `<button disabled>⏩ Sol ending…</button>`,
    }[p];
    $('controls').innerHTML = html ?? '';
    $('controls').classList.toggle('hidden', !html);
    const hint = { briefing: 'Plan your sol, then press Start.', paused: 'Paused.', decision: 'Mission control needs a decision.' }[p];
    $('phase-hint').textContent = hint ?? '';
    $('phase-hint').classList.toggle('hidden', !hint);
  }
  
  $('controls').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'start') controller.startSol();
    if (act === 'pause') controller.togglePause();
    if (act === 'end') controller.endSolEarly();
  });

  window.addEventListener('keydown', (e) => {
    if (!controller.state || $('hud').classList.contains('hidden')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (controller.phase === 'briefing') controller.startSol();
      else controller.togglePause();
    }
    if (e.code === 'Escape') {
      stopPlacing();
      $('shop').classList.add('hidden');
    }
  });

  bus.on('phase', renderControls);

  // ---------- task panel ----------

  function renderTask() {
    const t = controller.currentTask;
    const sol = controller.state.sol + 1;
    if (!t) {
      $('task-panel').innerHTML = `<div class="task-head">Mission control · Sol ${sol}</div><p class="muted">No orders today. Plan ahead!</p>`;
      return;
    }
    const reward = t.def.reward?.metal ? `+${t.def.reward.metal} metal` : '';
    $('task-panel').innerHTML = `
      <div class="task-head">Mission control · Sol ${sol}</div>
      <div class="task-title ${t.done ? 'done' : ''}"><span class="check">${t.done ? '✅' : '⬜'}</span>${esc(t.def.title)}</div>
      <p>${esc(t.def.text)}</p>
      <p class="task-reward">${t.done ? 'Done! ' : 'Reward: '}${reward}</p>
      <p class="science">${esc(t.def.why)}</p>`;
  }

  bus.on('task-complete', (def) => {
    toast(`Task complete: ${def.title}${def.reward?.metal ? ` (+${def.reward.metal} metal)` : ''}`);
    renderTask();
  });

  // ---------- build shop (popup) + placement bar ----------

  function renderShop() {
    const st = controller.state;
    const sector = getSector(data, st.sectorId);
    $('shop-grid').innerHTML = data.buildings
      .filter((d) => d.buildable !== false)
      .map((d) => {
        const cost = costOf(d, sector);
        const { w, h } = sizeOf(d);
        const atMax = d.maxCount && st.buildings.filter((b) => b.type === d.id).length >= d.maxCount;
        const regolith = d.cost?.regolith ?? 0;
        const broke = st.res.metal < cost || st.res.regolith < regolith;
        const power = d.powerOut ? `+${r1(d.powerOut * (d.solar ? sector.solarMult : 1))} kWh` : d.powerIn ? `−${d.powerIn} kWh` : '';
        return `<button class="shop-card ${atMax || broke ? 'locked' : ''}" data-build="${d.id}" ${atMax ? 'disabled' : ''}>
          <span class="icon">${d.icon}</span>
          <span class="name">${esc(d.name)}</span>
          <span class="meta">🔩 ${cost}${regolith ? ` · 🪨 ${regolith}` : ''}${power ? ` · ⚡ ${power}` : ''} · ${w}×${h}</span>
          <span class="desc">${esc(d.description)}</span>
          ${atMax ? '<span class="tag">Limit reached</span>' : broke ? '<span class="tag">Need more materials</span>' : ''}
        </button>`;
      })
      .join('');
  }

  function openShop() {
    stopPlacing();
    renderShop();
    $('shop').classList.remove('hidden');
    bus.emit('shop-open');
  }

  function startPlacing(id) {
    selectedBuilding = id;
    $('shop').classList.add('hidden');
    $('demolish-btn').classList.remove('active');
    bus.emit('demolish-mode', false);
    bus.emit('select-building', id);
    renderPlacing();
    showInfo(getDef(data, id));
  }

  function stopPlacing() {
    if (!selectedBuilding) return;
    selectedBuilding = null;
    bus.emit('select-building', null);
    renderPlacing();
    hideInfo();
  }

  function renderPlacing() {
    if (!selectedBuilding) return $('placing').classList.add('hidden');
    const def = getDef(data, selectedBuilding);
    const cost = costOf(def, getSector(data, controller.state.sectorId));
    $('placing-text').textContent = `Placing ${def.name} (🔩 ${cost}). Tap the map to build.`;
    $('placing').classList.remove('hidden');
  }

  $('build-btn').addEventListener('click', openShop);
  $('shop-close').addEventListener('click', () => $('shop').classList.add('hidden'));
  $('placing-done').addEventListener('click', stopPlacing);
  $('shop-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-build]');
    if (btn && !btn.disabled) startPlacing(btn.dataset.build);
  });

  $('demolish-btn').addEventListener('click', () => {
    const on = !$('demolish-btn').classList.contains('active');
    stopPlacing();
    $('demolish-btn').classList.toggle('active', on);
    bus.emit('demolish-mode', on);
  });

  // ---------- info card ----------

  function describe(def) {
    const sector = getSector(data, controller.state.sectorId);
    const parts = [];
    if (def.powerOut) parts.push(`Makes ${r1(def.powerOut * (def.solar ? sector.solarMult : 1))} kWh per sol`);
    if (def.powerIn) parts.push(`Uses ${def.powerIn} kWh per sol`);
    for (const [k, v] of Object.entries(def.produces ?? {})) {
      const amount = k === 'water' && def.usesSectorWater ? v * sector.waterMult : v;
      parts.push(`Makes ${r1(amount)} kg ${k} per sol`);
    }
    for (const [k, v] of Object.entries(def.consumes ?? {})) parts.push(`Uses ${r1(v)} kg ${k} per sol`);
    if (def.growSols) parts.push(`First harvest after ${def.growSols} sols`);
    if (def.batteryCapacity) parts.push(`Stores ${def.batteryCapacity} kWh`);
    if (def.waterRecovery) parts.push(`Recovers ${Math.round(def.waterRecovery * 100)}% of crew water`);
    if (def.addsRover) parts.push(`Adds ${def.addsRover} rover (each trip uses battery power)`);
    const { w, h } = sizeOf(def);
    parts.push(`Size: ${w}×${h} tiles`);
    if (def.maxCount) parts.push(`Limit: ${def.maxCount}`);
    return parts;
  }

  function showInfo(def, building = null) {
    inspectedNodeId = null;
    inspectedBuildingId = building?.id ?? null;
    const sol = controller.state.sol + 1;
    let statusText = building?.powered ? 'Running' : 'No power';
    if (building?.broken) statusText = building.repairAtSol ? `Broken: being repaired (ready sol ${building.repairAtSol})` : 'Broken';
    else if (building?.offFrom !== undefined && sol >= building.offFrom) statusText = `Switched off for the storm (until sol ${building.offUntil})`;
    const ok = building && building.powered && !building.broken;
    const status = building
      ? `<p class="status ${ok ? 'ok' : 'bad'}">${statusText}${
          def.growSols ? ` · crop ${Math.min(building.growth, def.growSols)}/${def.growSols} sols` : ''
        }</p>`
      : '';
    const shieldCfg = data.balance.radiation.shielding;
    const actions = [];
    if (building?.broken && !building.repairAtSol) {
      actions.push(`<button class="primary" data-act="repair">🔧 Repair now (🔩 ${repairCostOf(controller.state, data, building)})</button>`);
    }
    if (building?.type === 'habitat') {
      const lvl = controller.state.shielding;
      actions.push(
        `<p class="status">Regolith shielding: ${lvl}/${shieldCfg.max}</p>` +
          (lvl < shieldCfg.max ? `<button data-act="shield">🪨 Add a layer (🪨 ${shieldCfg.cost})</button>` : '')
      );
    }
    $('info').innerHTML = `
      <button class="close" aria-label="Close">✕</button>
      <h3>${def.icon} ${esc(def.name)}</h3>
      ${status}
      <p>${esc(def.description)}</p>
      <ul>${describe(def).map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      ${actions.join('')}
      <p class="science">${esc(def.scienceNote)}</p>`;
    $('info').classList.remove('hidden');
  }
  const hideInfo = () => $('info').classList.add('hidden');
  let inspectedBuildingId = null;
  $('info').addEventListener('click', (e) => {
    if (e.target.closest('.close')) return hideInfo();
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    const r = act === 'repair' ? controller.repair(inspectedBuildingId) : controller.shield();
    toast(r.ok ? (act === 'repair' ? 'Repaired and working again.' : 'Another layer of regolith on the habitat.') : r.reason, !r.ok);
    const b = controller.state.buildings.find((x) => x.id === inspectedBuildingId);
    if (b) showInfo(getDef(data, b.type), b);
  });

  bus.on('inspect', (b) => showInfo(getDef(data, b.type), b));

  bus.on('inspect-node', (node) => {
    inspectedNodeId = node.id;
    const nd = getNodeDef(data, node.type);
    const trip = planTrip(controller.state, data, node);
    const gives = Object.entries(nd.yield ?? {}).map(([k, v]) => `${v} ${k}`);
    const parts = [
      gives.length ? `Gives ${gives.join(', ')} per trip` : 'Gives nothing but space',
      `Round trip: about ${Math.ceil(trip.hours)} Mars hours (${r1(trip.workH)} h working)`,
      `Uses ${trip.kWh} kWh from your batteries`,
    ];
    if ((nd.loads ?? 1) > 1) parts.push(`Trips left before it's used up: ${node.loadsLeft}`);
    if (nd.clearsTile) parts.push('Clears the tile so you can build on it');
    $('info').innerHTML = `
      <button class="close" aria-label="Close">✕</button>
      <h3>${esc(nd.name)}</h3>
      <p class="status ${node.claimedBy ? 'ok' : ''}">${node.claimedBy ? 'Rover assigned' : 'Tap to send a rover'}</p>
      <p>${esc(nd.description)}</p>
      <ul>${parts.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      <p class="science">${esc(nd.scienceNote)}</p>`;
    $('info').classList.remove('hidden');
  });

  // ---------- stats bar ----------
  // while a sol runs, numbers slide from the start-of-sol values toward the projected end-of-sol values

  const chip = (icon, label, value, sub, level) =>
    `<div class="chip ${level}" data-chip="${label.toLowerCase()}"><span class="chip-icon">${icon}</span><div><div class="chip-label">${label}</div><div class="chip-value">${value}</div><div class="chip-sub">${sub}</div></div></div>`;

  function renderStats() {
    const s = controller.state;
    const proj = controller.projection;
    if (!s || !proj) return;
    const { balance } = data;
    const live = controller.phase === 'running' || controller.phase === 'fastforward' || controller.phase === 'paused';
    const f = live ? controller.solFraction() : 0;
    const shown = (k) => s.res[k] + (proj.res[k] - s.res[k]) * f;
    const pnet = proj.history.at(-1).net;
    const pw = previewPower(s, data);
    const netPower = pw.produced - pw.demand;

    const lifeChip = (key, label, icon) => {
      const v = shown(key);
      const net = pnet[key];
      let sub = `${signed(net)} kg/sol`;
      let level = '';
      if (net < 0) {
        const left = Math.floor(s.res[key] / -net);
        sub = `${left} sols left`;
        level = left < 8 ? 'bad' : left < 15 ? 'warn' : '';
      }
      return chip(icon, label, `${r1(v)} kg`, sub, level);
    };

    const dose = s.doseMsv + (proj.doseMsv - s.doseMsv) * f;
    const dosePct = dose / balance.radiation.doseBudgetMsv;
    $('stats').innerHTML = [
      lifeChip('oxygen', 'Oxygen', '💨'),
      lifeChip('water', 'Water', '💧'),
      lifeChip('food', 'Food', '🥫'),
      chip('⚡', 'Power', `${signed(netPower)} kWh/sol`, `Battery ${r1(s.res.battery)}/${pw.batteryCap}`, netPower < 0 ? 'bad' : ''),
      chip('☢️', 'Radiation', `${r1(dose)} mSv`, `Limit ${balance.radiation.doseBudgetMsv}`, dosePct > 0.85 ? 'bad' : dosePct > 0.6 ? 'warn' : ''),
      chip('🔩', 'Metal', `${Math.floor(s.res.metal)}`, 'For building', ''),
      chip('🪨', 'Regolith', `${Math.floor(s.res.regolith)}`, `Shielding ${s.shielding}/${balance.radiation.shielding.max}`, ''),
      chip(
        '🚙',
        'Rovers',
        `${s.rovers.filter((r) => !r.job).length}/${s.rovers.length} free`,
        `${pw.activeRovers} out working`,
        ''
      ),
    ].join('');
    $('sol').textContent = `Sol ${Math.min(s.sol + 1, balance.mission.lengthSols)} / ${balance.mission.lengthSols}`;
    $('sector-name').textContent = getSector(data, s.sectorId).name;
  }

  // ---------- clock + live numbers ----------

  let lastClock = '';
  let lastStats = 0;
  (function frame(now) {
    if (controller.state) {
      const mins = Math.floor(Math.min(controller.solFraction(), 0.9999) * 24 * 60);
      const text = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
      if (text !== lastClock) $('clock').textContent = lastClock = text;
      const live = controller.phase === 'running' || controller.phase === 'fastforward';
      if (live && now - lastStats > 150) {
        renderStats();
        lastStats = now;
      }
    }
    requestAnimationFrame(frame);
  })(0);

  // ---------- toasts ----------

  function toast(text, warn = false) {
    const el = document.createElement('div');
    el.className = `toast ${warn ? 'warn' : ''}`;
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }
  bus.on('toast', ({ text, warn }) => toast(text, warn));

  // things that happen mid-sol get a toast now and a line in the sol report later
  bus.on('sim-event', (e) => {
    if (e.type === 'rover_home') toast(e.metal ? `🚙 Rover back with ${e.metal} metal.` : e.regolith ? `🚙 Rover cleared a boulder: +${e.regolith} regolith.` : '🚙 Rover back.');
    if (e.type === 'node_discovered') toast(`🔭 Rover cameras spotted a new ${getNodeDef(data, e.node.type).name.toLowerCase()}.`);
  });

  // ---------- daily report ----------

  bus.on('sol-report', (r) => {
    const row = (label, value, good) => `<li class="${good === undefined ? '' : good ? 'good' : 'bad'}"><span>${label}</span><strong>${value}</strong></li>`;
    const changes = [
      row('💨 Oxygen', `${signed(r.net.oxygen)} kg`, r.net.oxygen >= 0),
      row('💧 Water', `${signed(r.net.water)} kg`, r.net.water >= 0),
      row('🥫 Food', `${signed(r.net.food)} kg`, r.net.food >= 0),
      row('⚡ Power', `made ${r1(r.produced)} / needed ${r1(r.demand)} kWh`, r.produced >= r.demand),
    ];

    const happened = [];
    if (r.unpowered.length) happened.push(`⚠️ Power shortage: ${[...new Set(r.unpowered)].map((u) => consumerName(data, u)).join(', ')} shut down.`);
    if (r.cropLost) happened.push(`🥀 ${r.cropLost} greenhouse crop${r.cropLost > 1 ? 's' : ''} died. Growing starts again.`);
    for (const e of r.events) {
      if (e.type === 'rover_home') happened.push(e.metal ? `🚙 A rover came home with ${e.metal} metal.` : `🚙 A rover cleared a boulder (+${e.regolith ?? 0} regolith).`);
      if (e.type === 'node_discovered') happened.push(`🔭 Rover cameras spotted a new ${getNodeDef(data, e.node.type).name.toLowerCase()}.`);
    }
    for (const b of controller.state.buildings) {
      const def = getDef(data, b.type);
      if (def.growSols && b.growth === def.growSols) happened.push('🥬 First harvest from a greenhouse!');
    }

    const task = r.task
      ? `<p class="report-task ${r.task.done ? 'good' : 'bad'}">${r.task.done ? '✅' : '❌'} ${esc(r.task.def.title)}: ${
          r.task.done ? `done${r.task.def.reward?.metal ? `, +${r.task.def.reward.metal} metal` : ''}` : 'skipped'
        }</p>`
      : '<p class="muted">No task today.</p>';

    $('report-title').textContent = `Sol ${r.sol} report`;
    $('report-body').innerHTML = `
      <ul class="report-changes">${changes.join('')}</ul>
      ${happened.length ? `<ul class="report-events">${happened.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
      <h2>Mission control</h2>
      ${task}
      ${r.next ? `<p><strong>Next:</strong> ${esc(r.next.title)}</p>` : ''}`;
    $('report-start').textContent = `▶ Start sol ${r.sol + 1}`;
    $('report').classList.remove('hidden');
  });

  $('report-start').addEventListener('click', () => {
    $('report').classList.add('hidden');
    controller.closeReport();
    controller.startSol();
  });
  $('report-plan').addEventListener('click', () => {
    $('report').classList.add('hidden');
    controller.closeReport(); // stays in briefing: build first, then press Start
  });

  // ---------- event banner: what's going on right now ----------

  function renderBanner() {
    const s = controller.state;
    const sol = s.sol + 1;
    const items = [];
    const storm = stormOn(s, sol);
    if (storm) items.push(`🌪️ Dust storm: solar at ${Math.round(data.events.events.find((e) => e.id === 'dust_storm').solarMult * 100)}% (until sol ${storm.toSol})`);
    else {
      const coming = s.events.active.find((a) => a.type === 'dust_storm' && a.fromSol > sol);
      if (coming) items.push(`🌪️ Dust storm arriving on sol ${coming.fromSol}`);
    }
    if (s.events.dust > 0.001 && !storm) items.push(`🟫 Dusty panels: −${Math.round(s.events.dust * 100)}% solar (wind is clearing them)`);
    const spe = s.events.active.find((a) => a.type === 'solar_particle_event' && a.sol === sol);
    if (spe) items.push(`☢️ Solar particle event today: +${r1(spe.dose)} mSv`);
    const broken = s.buildings.filter((b) => b.broken);
    if (broken.length) items.push(`🔧 Broken: ${broken.map((b) => getDef(data, b.type).name).join(', ')}`);
    $('event-banner').innerHTML = items.map((i) => `<span>${esc(i)}</span>`).join('');
    $('event-banner').classList.toggle('hidden', !items.length);
  }

  // ---------- decision card ----------

  bus.on('decision', (d) => {
    if (!d) return;
    $('decision-title').textContent = `${d.icon} ${d.title}`;
    $('decision-warning').textContent = d.warning;
    $('decision-choices').innerHTML = d.choices
      .map(
        (c) => `<button class="choice ${c.ok ? '' : 'locked'}" data-choice="${c.id}" ${c.ok ? '' : 'disabled'}>
          <strong>${esc(c.label)}</strong><span>${esc(c.detail)}</span>${c.ok ? '' : `<em>${esc(c.why)}</em>`}
        </button>`
      )
      .join('');
    $('decision-story').textContent = d.def.realStory;
    $('decision-science').textContent = d.def.science;
    $('decision').classList.remove('hidden');
  });

  $('decision-choices').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-choice]');
    if (!btn || btn.disabled) return;
    const label = btn.querySelector('strong').textContent;
    const r = controller.decide(btn.dataset.choice);
    if (!r.ok) return toast(r.reason, true);
    $('decision').classList.add('hidden');
    toast(`Decision: ${label}`);
  });

  // ---------- debrief ----------

  bus.on('ended', (d) => {
    $('report').classList.add('hidden');
    $('debrief-panel').className = `panel ${d.outcome}`;
    $('debrief-headline').textContent = d.headline;
    $('debrief-lines').innerHTML = d.lines.map((l) => `<li>${esc(l)}</li>`).join('');
    $('debrief-lesson').textContent = d.lesson;
    $('debrief').classList.remove('hidden');
  });

  $('retry-btn').addEventListener('click', () => {
    $('debrief').classList.add('hidden');
    startGame(controller.state.sectorId);
  });
  $('change-sector-btn').addEventListener('click', () => {
    $('debrief').classList.add('hidden');
    $('hud').classList.add('hidden');
    $('sector-picker').classList.remove('hidden');
  });

  // ---------- refresh hooks ----------

  bus.on('tick', () => {
    const cleared = inspectedNodeId !== null && !controller.state.nodes.some((n) => n.id === inspectedNodeId);
    if (cleared) hideInfo();
  });

  bus.on('new-game', () => {
    selectedBuilding = null;
    renderPlacing();
    $('demolish-btn').classList.remove('active');
    $('report').classList.add('hidden');
    $('shop').classList.add('hidden');
    $('decision').classList.add('hidden');
    hideInfo();
    setTimeout(() => toast('Tap meteorites and wreckage (🔩) to send your rover for metal.'), 400);
  });

  bus.on('state', () => {
    renderStats();
    renderBanner();
    if (!$('shop').classList.contains('hidden')) renderShop();
    renderTask();
    renderControls();
  });
  bus.on('tick', () => {
    renderStats();
    renderBanner();
    renderTask();
  });
}