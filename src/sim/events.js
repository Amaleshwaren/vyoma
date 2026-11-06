// mars events: dust storms, solar particle events, equipment failures.
// pure javascript like the sim. an event is rolled at the start of a sol, waits as 'pending'
// until the player picks a choice on the decision card, then becomes 'active' until it ends.
import { getDef, getSector, costOf, makeRng, hashString } from './sim.js';

export const eventDef = (data, type) => data.events.events.find((e) => e.id === type);

// is this building switched off by a decision, or broken, on sol `sol`?
export function isOffline(b, sol) {
  return b.broken || (b.offFrom !== undefined && sol >= b.offFrom && sol <= b.offUntil);
}

export function stormOn(state, sol) {
  return state.events.active.find((a) => a.type === 'dust_storm' && sol >= a.fromSol && sol <= a.toSol) ?? null;
}

// solar output multiplier on sol `sol`: storms dim the sky, leftover dust dims the panels
export function solarFactor(state, data, sol) {
  const storm = stormOn(state, sol);
  const base = storm ? eventDef(data, 'dust_storm').solarMult : 1;
  return base * (1 - state.events.dust);
}

export function shieldingMult(state, data, kind) {
  const cfg = data.balance.radiation.shielding;
  return 1 - state.shielding * (kind === 'spe' ? cfg.speCut : cfg.gcrCut);
}

// ---------- rolling a new event ----------

export function rollEvent(state, data) {
  const sol = state.sol + 1;
  const cfg = data.events.schedule;
  const ev = state.events;
  if (sol < cfg.firstSol || ev.pending || sol - ev.lastSol < cfg.minGapSols) return null;
  const rng = makeRng(hashString(`${state.sectorId}-event-${sol}`));
  const chance = Math.min(cfg.maxChance, cfg.baseChance + cfg.chancePerSol * (sol - cfg.firstSol));
  if (rng() >= chance) return null;

  const sector = getSector(data, state.sectorId);
  const options = data.events.events
    .filter((e) => !(e.id === 'dust_storm' && stormOn(state, sol + 1)))
    .filter((e) => e.id !== 'equipment_failure' || failureTargets(state, data).length)
    .map((e) => ({ e, w: e.weight * (sector.eventWeights?.[e.id] ?? 1) }));
  const total = options.reduce((a, o) => a + o.w, 0);
  if (!total) return null;
  let pick = rng() * total;
  const def = options.find((o) => (pick -= o.w) < 0)?.e ?? options.at(-1).e;

  const pending = { type: def.id, sol };
  if (def.id === 'dust_storm') {
    const [lo, hi] = def.durationSols;
    pending.length = lo + Math.floor(rng() * (hi - lo + 1));
  }
  if (def.id === 'equipment_failure') {
    const targets = failureTargets(state, data);
    const b = targets[Math.floor(rng() * targets.length)];
    b.broken = true; // it breaks right now; the card only decides what to do about it
    pending.buildingId = b.id;
  }
  ev.pending = pending;
  ev.lastSol = sol;
  return pending;
}

function failureTargets(state, data) {
  const types = eventDef(data, 'equipment_failure').targets;
  return state.buildings.filter((b) => types.includes(b.type) && !b.broken);
}

// ---------- the decision card ----------

function repairCosts(state, data, b) {
  const d = eventDef(data, 'equipment_failure');
  const full = costOf(getDef(data, b.type), getSector(data, state.sectorId));
  return { repairNow: Math.ceil(full * d.repairNowFraction), repairSlow: Math.ceil(full * d.repairSlowFraction) };
}

export function speDose(state, data) {
  const d = eventDef(data, 'solar_particle_event');
  return d.doseMsv * getSector(data, state.sectorId).radiationMult;
}

// the pending event, ready to show: text filled in, each choice marked available or not (with a reason)
export function describePending(state, data) {
  const p = state.events.pending;
  if (!p) return null;
  const def = eventDef(data, p.type);
  const vars = { slowSols: def.slowSols, cost: data.balance.radiation.shielding.cost };
  const b = p.buildingId ? state.buildings.find((x) => x.id === p.buildingId) : null;
  if (b) Object.assign(vars, repairCosts(state, data, b), { building: getDef(data, b.type).name });
  if (p.type === 'solar_particle_event') vars.dose = Math.round(speDose(state, data) * shieldingMult(state, data, 'spe'));
  const fill = (t) => t.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

  const choices = def.choices.map((c) => {
    let ok = true;
    let why = '';
    const req = c.requires ?? {};
    if (req.building && !state.buildings.some((x) => x.type === req.building && !x.broken)) {
      ok = false;
      why = `You need a ${getDef(data, req.building).name} first.`;
    }
    if (req.regolith) {
      const need = req.regolith === 'shieldingCost' ? vars.cost : req.regolith;
      if (state.res.regolith < need) [ok, why] = [false, `Needs ${need} regolith (you have ${Math.floor(state.res.regolith)}).`];
      if (state.shielding >= data.balance.radiation.shielding.max) [ok, why] = [false, 'The habitat already has maximum shielding.'];
    }
    if (req.metal) {
      const need = vars[req.metal];
      if (state.res.metal < need) [ok, why] = [false, `Needs ${need} metal (you have ${Math.floor(state.res.metal)}).`];
    }
    return { id: c.id, label: c.label, detail: fill(c.detail), ok, why };
  });
  return { def, pending: p, title: def.name, icon: def.icon, warning: fill(def.warning), choices };
}

export function choose(state, data, choiceId) {
  const desc = describePending(state, data);
  if (!desc) return { ok: false, reason: 'No decision waiting.' };
  const choice = desc.choices.find((c) => c.id === choiceId);
  if (!choice || !choice.ok) return { ok: false, reason: choice?.why || 'That choice is not available.' };
  const { def, pending: p } = desc;
  const effect = def.choices.find((c) => c.id === choiceId).effect ?? {};
  const log = { type: p.type, sol: p.sol, choice: choiceId };

  if (p.type === 'dust_storm') {
    const storm = { type: 'dust_storm', fromSol: p.sol + 1, toSol: p.sol + p.length };
    state.events.active.push(storm);
    Object.assign(log, { from: storm.fromSol, to: storm.toSol });
    if (effect.switchOff) {
      for (const b of state.buildings.filter((x) => x.type === effect.switchOff)) {
        b.offFrom = storm.fromSol;
        b.offUntil = storm.toSol;
      }
    }
  }

  if (p.type === 'solar_particle_event') {
    if (effect.addShielding) {
      state.res.regolith -= data.balance.radiation.shielding.cost;
      state.shielding += effect.addShielding;
    }
    const dose = speDose(state, data) * shieldingMult(state, data, 'spe') * (effect.doseMult ?? 1);
    state.events.active.push({ type: 'solar_particle_event', sol: p.sol, dose });
    log.dose = Math.round(dose * 10) / 10;
  }

  if (p.type === 'equipment_failure') {
    const b = state.buildings.find((x) => x.id === p.buildingId);
    const costs = repairCosts(state, data, b);
    log.building = b.type;
    if (effect.repair === 'now') {
      state.res.metal -= costs.repairNow;
      b.broken = false;
    } else if (effect.repair === 'slow') {
      state.res.metal -= costs.repairSlow;
      b.repairAtSol = p.sol + def.slowSols;
    }
  }

  state.events.log.push(log);
  state.events.pending = null;
  return { ok: true };
}

// repair a broken building later, from its info card (same price as 'repair now')
export function repairBuilding(state, data, buildingId) {
  const b = state.buildings.find((x) => x.id === buildingId);
  if (!b?.broken) return { ok: false, reason: 'That building is not broken.' };
  const { repairNow } = repairCosts(state, data, b);
  if (state.res.metal < repairNow) return { ok: false, reason: `Repairing costs ${repairNow} metal.` };
  state.res.metal -= repairNow;
  b.broken = false;
  delete b.repairAtSol;
  // so the debrief doesn't claim it was never repaired
  const left = state.events.log.findLast((l) => l.type === 'equipment_failure' && l.building === b.type && l.choice === 'leave');
  if (left) left.choice = 'repaired_later';
  return { ok: true, cost: repairNow };
}

export function repairCostOf(state, data, b) {
  return repairCosts(state, data, b).repairNow;
}

// pile regolith on the habitat any time, from its info card
export function addShielding(state, data) {
  const cfg = data.balance.radiation.shielding;
  if (state.shielding >= cfg.max) return { ok: false, reason: 'The habitat already has maximum shielding.' };
  if (state.res.regolith < cfg.cost) return { ok: false, reason: `Needs ${cfg.cost} regolith. Send rovers to clear boulders.` };
  state.res.regolith -= cfg.cost;
  state.shielding += 1;
  return { ok: true };
}

// ---------- end of sol (called from tick) ----------

// radiation from this sol's solar particle events
export function speDoseOn(state, sol) {
  return state.events.active.filter((a) => a.type === 'solar_particle_event' && a.sol === sol).reduce((s, a) => s + a.dose, 0);
}

export function endOfSol(state, data) {
  const sol = state.sol;
  const storm = eventDef(data, 'dust_storm');
  for (const b of state.buildings) {
    if (b.repairAtSol !== undefined && sol >= b.repairAtSol) {
      b.broken = false;
      delete b.repairAtSol;
    }
    if (b.offUntil !== undefined && sol >= b.offUntil) {
      delete b.offFrom;
      delete b.offUntil;
    }
  }
  // storms that end today leave dusty panels; otherwise wind slowly cleans them
  const ending = state.events.active.filter((a) => a.type === 'dust_storm' && a.toSol === sol);
  if (ending.length) state.events.dust = storm.dustAfter;
  else if (!stormOn(state, sol)) state.events.dust = Math.max(0, state.events.dust - storm.dustRecoverPerSol);
  state.events.active = state.events.active.filter((a) => (a.type === 'dust_storm' ? a.toSol > sol : a.sol > sol));
}