// the whole mars simulation. pure javascript: no phaser, no DOM.
// data goes in as plain objects, state comes out as plain objects,
// so it runs in node for tests and every failure can be traced back to a cause.

import { isOffline, solarFactor, shieldingMult, speDoseOn, endOfSol } from './events.js';

// ---------- helpers ----------

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32: tiny seeded rng, so the same sector always gets the same map
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function getSector(data, id) {
  const s = data.sectors.find((x) => x.id === id);
  if (!s) throw new Error(`unknown sector: ${id}`);
  return s;
}

export function getDef(data, type) {
  const d = data.buildings.find((x) => x.id === type);
  if (!d) throw new Error(`unknown building: ${type}`);
  return d;
}

export function getNodeDef(data, type) {
  const d = data.nodes.find((x) => x.id === type);
  if (!d) throw new Error(`unknown node: ${type}`);
  return d;
}

export function costOf(def, sector) {
  return Math.ceil((def.cost?.metal ?? 0) * (sector.buildCostMult ?? 1));
}

// buildings cover w x h tiles from their top-left corner (x, y)
export function buildingAt(state, x, y) {
  return state.buildings.find((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) || null;
}

export function sizeOf(def) {
  return { w: def.size?.[0] ?? 1, h: def.size?.[1] ?? 1 };
}

// every tile of a w x h footprint is open ground with nothing on it
export function areaFree(state, x, y, w, h) {
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) if (!isFree(state, x + dx, y + dy)) return false;
  return true;
}

export function nodeAt(state, x, y) {
  return state.nodes.find((n) => n.x === x && n.y === y) || null;
}

export function terrainAt(state, x, y) {
  const n = state.grid.size;
  if (x < 0 || y < 0 || x >= n || y >= n) return null;
  return state.grid.terrain[y * n + x]; // 'ground' | 'boulder' | 'cliff'
}

// ground with nothing on it
export function isFree(state, x, y) {
  return terrainAt(state, x, y) === 'ground' && !buildingAt(state, x, y) && !nodeAt(state, x, y);
}

// ---------- map ----------

// open ground forms a ragged blob around the habitat: closest tiles (plus noise) win.
// the rest is rough terrain: some clearable boulders, some permanent cliffs.
export function generateMap(sector, data) {
  const { size, jitter } = data.balance.grid;
  const rng = makeRng(hashString(sector.id));
  const h = Math.floor(size / 2);
  const tiles = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      tiles.push({ x, y, i: y * size + x, d: Math.hypot(x - h, y - h), score: Math.hypot(x - h, y - h) + rng() * jitter });
    }
  }
  tiles.sort((a, b) => a.score - b.score);
  const open = Math.max(1, Math.round(size * size * sector.buildableFraction));
  const terrain = new Array(size * size);
  tiles.forEach((t, k) => {
    terrain[t.i] = k < open ? 'ground' : rng() < sector.boulderFraction ? 'boulder' : 'cliff';
  });
  // the landing pad (3x3 around the centre) is always clear
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) terrain[(h + dy) * size + h + dx] = 'ground';

  const nodes = [];
  let nextNodeId = 1;
  // every boulder tile carries a boulder node
  for (const t of tiles) if (terrain[t.i] === 'boulder') nodes.push({ id: nextNodeId++, type: 'boulder', x: t.x, y: t.y, claimedBy: null, loadsLeft: 1 });

  // metal nodes go on open ground, away from the landing spot (4+ tiles) so the starter kit fits
  const spots = tiles.filter((t) => terrain[t.i] === 'ground' && t.d >= 4);
  for (let k = spots.length - 1; k > 0; k--) {
    const j = Math.floor(rng() * (k + 1));
    [spots[k], spots[j]] = [spots[j], spots[k]];
  }
  // wreckage lands close, everything else anywhere
  const order = Object.entries(sector.nodes ?? {}).sort(([a], [b]) => (a === 'lander_wreck' ? -1 : b === 'lander_wreck' ? 1 : 0));
  for (const [type, count] of order) {
    for (let c = 0; c < count && spots.length; c++) {
      let idx = 0;
      if (type === 'lander_wreck') {
        idx = spots.findIndex((s) => s.d >= 4 && s.d <= 6);
        if (idx < 0) idx = 0;
      }
      const [s] = spots.splice(idx, 1);
      nodes.push({ id: nextNodeId++, type, x: s.x, y: s.y, claimedBy: null, loadsLeft: getNodeDef(data, type).loads ?? 1 });
    }
  }
  return { grid: { size, terrain, habitat: { x: h, y: h } }, nodes, nextNodeId };
}

// ---------- state ----------

export function createState(sectorId, data) {
  const { balance } = data;
  const sector = getSector(data, sectorId);
  const { grid, nodes, nextNodeId } = generateMap(sector, data);
  const state = {
    sectorId,
    sol: 0,
    status: 'playing', // 'playing' | 'failed' | 'complete'
    failure: null,
    crew: balance.mission.crew,
    res: {
      oxygen: balance.start.oxygen,
      water: balance.start.water,
      food: balance.start.food,
      metal: sector.startMetal,
      regolith: balance.start.regolith ?? 0,
      battery: balance.start.battery ?? 0,
    },
    shielding: 0,
    events: { pending: null, active: [], log: [], lastSol: 0, dust: 0},
    doseMsv: 0,
    grid,
    nodes,
    nextNodeId,
    buildings: [],
    rovers: [],
    nextId: 1,
    history: [],
    metalScavenged: 0,
    stats: { cleared: {}, discoveries: 0 },
    solClock: 0, // how much of the current sol has already been played out (0..1)
    discoveryClock: 0, // Mars hours since the last discovery
    tasks: { current: null, log: [] },
  };
  const hab = sizeOf(getDef(data, 'habitat'));
  addBuilding(state, 'habitat', grid.habitat.x - Math.floor(hab.w / 2), grid.habitat.y - Math.floor(hab.h / 2), 0, hab);
  for (const { type, count } of balance.start.buildings ?? []) {
    const size = sizeOf(getDef(data, type));
    for (let i = 0; i < count; i++) {
      const spot = findFreeSpotNear(state, grid.habitat.x, grid.habitat.y, size.w, size.h);
      if (spot) addBuilding(state, type, spot.x, spot.y, 0, size);
    }
  }
  for (let i = 0; i < (balance.rover?.start ?? 1); i++) addRover(state);
  return state;
}

function addBuilding(state, type, x, y, paid, size) {
  const b = { id: state.nextId++, type, x, y, w: size.w, h: size.h, powered: true, growth: 0, paid };
  state.buildings.push(b);
  return b;
}

function addRover(state) {
  const r = { id: state.nextId++, job: null, powered: true };
  state.rovers.push(r);
  return r;
}

// top-left corner of the nearest free w x h area to (cx, cy), or null if nothing fits
export function findFreeSpotNear(state, cx, cy, w = 1, h = 1) {
  const n = state.grid.size;
  let best = null;
  for (let y = 0; y <= n - h; y++) {
    for (let x = 0; x <= n - w; x++) {
      if (!areaFree(state, x, y, w, h)) continue;
      const d = Math.hypot(x + (w - 1) / 2 - cx, y + (h - 1) / 2 - cy);
      if (!best || d < best.d) best = { x, y, d };
    }
  }
  return best;
}

// ---------- building ----------

export function canPlace(state, data, type, x, y) {
  if (state.status !== 'playing') return { ok: false, reason: 'The mission is over.' };
  const def = getDef(data, type);
  const sector = getSector(data, state.sectorId);
  const cost = costOf(def, sector);
  const { w, h } = sizeOf(def);
  if (def.buildable === false) return { ok: false, reason: `${def.name} can't be built.`, cost };
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const tx = x + dx;
      const ty = y + dy;
      const node = nodeAt(state, tx, ty);
      if (node) {
        const nd = getNodeDef(data, node.type);
        return { ok: false, reason: `There's a ${nd.name.toLowerCase()} in the way. Tap it to send a rover.`, cost };
      }
      if (terrainAt(state, tx, ty) === null) return { ok: false, reason: `${def.name} is ${w}×${h} and doesn't fit there.`, cost };
      if (terrainAt(state, tx, ty) !== 'ground') return { ok: false, reason: 'That ground is too rough to build on.', cost };
      if (buildingAt(state, tx, ty)) return { ok: false, reason: 'Something is already built there.', cost };
    }
  }
  if (def.maxCount && state.buildings.filter((b) => b.type === type).length >= def.maxCount) {
    return { ok: false, reason: `You can only have ${def.maxCount} ${def.name}.`, cost };
  }
  if (state.res.metal < cost) {
    return { ok: false, reason: `Not enough metal: need ${cost}, have ${Math.floor(state.res.metal)}. Send a rover scavenging.`, cost };
  }
  const regolith = def.cost?.regolith ?? 0;
  if (state.res.regolith < regolith) {
    return { ok: false, reason: `Not enough regolith: need ${regolith}, have ${Math.floor(state.res.regolith)}. Send a rover to clear boulders.`, cost};
  }
  return { ok: true, cost, regolith };
}

export function placeBuilding(state, data, type, x, y) {
  const check = canPlace(state, data, type, x, y);
  if (!check.ok) return check;
  state.res.metal -= check.cost;
  state.res.regolith -= check.regolith;
  const def = getDef(data, type);
  const b = addBuilding(state, type, x, y, check.cost, sizeOf(def));
  for (let i = 0; i < (def.addsRover ?? 0); i++) addRover(state);
  return { ok: true, building: b };
}

export function demolishBuilding(state, data, x, y) {
  if (state.status !== 'playing') return { ok: false, reason: 'The mission is over.' };
  const b = buildingAt(state, x, y);
  if (!b) return { ok: false, reason: 'Nothing to demolish there.' };
  const def = getDef(data, b.type);
  if (def.buildable === false) return { ok: false, reason: `You can't demolish the ${def.name}.` };
  if (def.addsRover) {
    // remove an idle rover; refuse if they're all out working
    const idle = state.rovers.filter((r) => !r.job);
    if (idle.length < def.addsRover) return { ok: false, reason: 'Wait for the rovers to come home first.' };
    const drop = new Set(idle.slice(-def.addsRover).map((r) => r.id));
    state.rovers = state.rovers.filter((r) => !drop.has(r.id));
  }
  const refund = Math.floor(b.paid * data.balance.demolishRefund);
  state.res.metal += refund;
  state.buildings = state.buildings.filter((o) => o !== b);
  return { ok: true, refund, name: def.name };
}

// ---------- scavenging ----------

// trip plan in Mars hours (1/24 sol): drive out, work, drive back. energy comes from the battery up front.
export function planTrip(state, data, node) {
  const { x: hx, y: hy } = state.grid.habitat;
  const cfg = data.balance.rover;
  const drive = Math.hypot(node.x - hx, node.y - hy) / cfg.speedTilesPerHour;
  const work = getNodeDef(data, node.type).workHours;
  const hours = drive * 2 + work;
  return { outH: drive, workH: work, backH: drive, hours, kWh: Math.ceil(hours * cfg.kWhPerHour) };
}

export function sendRover(state, data, nodeId) {
  if (state.status !== 'playing') return { ok: false, reason: 'The mission is over.' };
  const node = state.nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, reason: 'Nothing to scavenge there.' };
  if (node.claimedBy) return { ok: false, reason: 'A rover is already on its way there.' };
  const rover = state.rovers.find((r) => !r.job);
  if (!rover) return { ok: false, reason: 'All rovers are busy. Build a Rover Bay for another one.' };
  const trip = planTrip(state, data, node);
  if (state.res.battery < trip.kWh) {
    return { ok: false, reason: `Not enough stored power: this trip needs ${trip.kWh} kWh, batteries have ${Math.floor(state.res.battery)}.` };
  }
  state.res.battery -= trip.kWh;
  rover.job = { nodeId, nodeType: node.type, ...trip, elapsedH: 0, from: { ...state.grid.habitat }, to: { x: node.x, y: node.y }, cargo: null };
  node.claimedBy = rover.id;
  return { ok: true, rover, trip };
}

// play out part of a sol: rovers drive and deliver, new finds get spotted.
// the controller calls this every frame; tick() plays out whatever is left of the sol,
// so tests that only call tick() still get a full sol of rover time.
export function advanceTime(state, data, dSol) {
  const step = Math.min(dSol, 1 - state.solClock);
  if (step <= 0 || state.status !== 'playing') return [];
  state.solClock += step;
  const hours = step * 24;
  const events = [];

  for (const r of state.rovers) {
    if (!r.job) continue;
    const j = r.job;
    j.elapsedH += hours;
    if (!j.cargo && j.elapsedH >= j.outH + j.workH) {
      const node = state.nodes.find((n) => n.id === j.nodeId);
      j.cargo = {};
      if (node) {
        const nd = getNodeDef(data, node.type);
        j.cargo = { ...nd.yield };
        node.loadsLeft = (node.loadsLeft ?? 1) - 1;
        node.claimedBy = null; // free for another trip if loads remain
        if (node.loadsLeft <= 0) {
          if (nd.clearsTile) state.grid.terrain[node.y * state.grid.size + node.x] = 'ground';
          state.nodes = state.nodes.filter((n) => n !== node);
          state.stats.cleared[node.type] = (state.stats.cleared[node.type] ?? 0) + 1;
          events.push({ type: 'node_cleared', node });
        }
      }
    }
    if (j.elapsedH >= j.hours) {
      const metal = j.cargo?.metal ?? 0;
      const regolith = j.cargo?.regolith ?? 0;
      state.res.metal += metal;
      state.res.regolith += regolith;
      state.metalScavenged += metal;
      events.push({ type: 'rover_home', rover: r.id, metal, regolith, nodeType: j.nodeType });
      r.job = null;
    }
  }

  const cfg = data.balance.discovery;
  if (cfg) {
    state.discoveryClock += hours;
    while (state.discoveryClock >= cfg.everyHours) {
      state.discoveryClock -= cfg.everyHours;
      const found = discoverNode(state, data);
      if (found) events.push({ type: 'node_discovered', node: found });
    }
  }
  return events;
}

// reveal one new node on free ground far from the habitat (it was always there, now it's found)
export function discoverNode(state, data) {
  const cfg = data.balance.discovery;
  const active = state.nodes.filter((n) => n.type !== 'boulder' && !n.claimedBy).length;
  if (active >= cfg.maxActive) return null;
  const { x: hx, y: hy } = state.grid.habitat;
  const n = state.grid.size;
  const spots = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (isFree(state, x, y) && Math.hypot(x - hx, y - hy) >= cfg.minDistance) spots.push({ x, y });
    }
  }
  if (!spots.length) return null;
  state.stats.discoveries += 1;
  const rng = makeRng(hashString(state.sectorId) + state.stats.discoveries); // repeatable for tests
  const s = spots[Math.floor(rng() * spots.length)];
  const node = { id: state.nextNodeId++, type: cfg.type, x: s.x, y: s.y, claimedBy: null, loadsLeft: getNodeDef(data, cfg.type).loads ?? 1 };
  state.nodes.push(node);
  return node;
}

// ---------- power ----------

// what the base makes and wants on sol `sol` (default: the sol being played), without changing anything.
// broken or switched-off buildings neither make nor use power; storms and dust dim solar.
export function previewPower(state, data, sol = state.sol + 1) {
  const sector = getSector(data, state.sectorId);
  const sun = solarFactor(state, data, sol);
  let produced = 0;
  let demand = 0;
  let batteryCap = 0;
  for (const b of state.buildings) {
    const def = getDef(data, b.type);
    if (def.batteryCapacity) batteryCap += def.batteryCapacity;
    if (isOffline(b, sol)) continue;
    if (def.powerOut) produced += def.powerOut * (def.solar ? sector.solarMult * sun : 1);
    if (def.powerIn) demand += def.powerIn;
    
  }
  const activeRovers = state.rovers.filter((r) => r.job).length;
  return { produced, demand, batteryCap, activeRovers };
}

// what the base will look like at the end of this sol if nothing else changes.
// used for live display and for task checks. never touches the real state.
export function projectSol(state, data) {
  const copy = structuredClone(state);
  tick(copy, data);
  return copy;
}

// ---------- the sol tick ----------

export function tick(state, data) {
  if (state.status !== 'playing') return [];
  const { balance } = data;
  const sector = getSector(data, state.sectorId);
  // finish playing out the sol (rovers, discoveries), then do the end-of-sol accounting
  const events = advanceTime(state, data, 1 - state.solClock);
  state.solClock = 0;
  state.sol += 1;
  const before = { oxygen: state.res.oxygen, water: state.res.water, food: state.res.food };

  // 1. power: pool production + stored battery, hand it out by priority (life support first)
  const { produced, demand, batteryCap } = previewPower(state, data, state.sol);
  let available = produced + state.res.battery;
  for (const b of state.buildings) if (isOffline(b, state.sol)) b.powered = false; // broken or switched off
  const consumers = state.buildings
    .filter((b) => getDef(data, b.type).powerIn > 0 && !isOffline(b, state.sol))
    .map((b) => ({ obj: b, name: b.type, need: getDef(data, b.type).powerIn, priority: getDef(data, b.type).priority }))
    .sort((a, b) => b.priority - a.priority || a.obj.id - b.obj.id);
  const unpowered = [];
  for (const c of consumers) {
    if (available >= c.need) {
      available -= c.need;
      c.obj.powered = true;
    } else {
      c.obj.powered = false;
      unpowered.push(c.name);
    }
  }
  for (const b of state.buildings) if (!(getDef(data, b.type).powerIn > 0) && !isOffline(b, state.sol)) b.powered = true;
  state.res.battery = Math.min(batteryCap, available); // leftovers charge the battery, extra is wasted
  if (unpowered.length) events.push({ type: 'brownout', buildings: [...new Set(unpowered)] });

  // 3. production
  let cropLost = 0;
  for (const b of state.buildings) {
    const def = getDef(data, b.type);
    const p = def.produces || {};
    if (def.growSols) {
      const needWater = def.consumes?.water ?? 0;
      if (b.powered && state.res.water >= needWater) {
        state.res.water -= needWater;
        b.growth += 1;
        b.dark = 0;
        if (p.oxygen) state.res.oxygen += p.oxygen; // photosynthesis
        if (b.growth >= def.growSols && p.food) state.res.food += p.food;
      } else {
        // one bad sol pauses growth; plants die after cropDiesAfter bad sols in a row (no light, heat or water)
        b.dark = (b.dark ?? 0) + 1;
        if (b.growth > 0 && b.dark >= (def.cropDiesAfter ?? 1)) {
          b.growth = 0;
          cropLost += 1;
        }
      }
      continue;
    }
    if (!b.powered) continue;
    if (p.oxygen) state.res.oxygen += p.oxygen;
    if (p.water) state.res.water += p.water * (def.usesSectorWater ? sector.waterMult : 1);
  }
  if (cropLost) events.push({ type: 'crop_lost', count: cropLost });

  // 4. crew consumption (recyclers don't stack: best working one wins)
  const rates = balance.crewPerSol;
  let recovery = 0;
  for (const b of state.buildings) {
    const def = getDef(data, b.type);
    if (b.powered && def.waterRecovery) recovery = Math.max(recovery, def.waterRecovery);
  }
  state.res.oxygen -= state.crew * rates.oxygen;
  state.res.water -= state.crew * rates.water * (1 - recovery);
  state.res.food -= state.crew * rates.food;

  // 5. radiation
  // everyday cosmic rays (shielding barely helps) + any solar particle event today (shielding helps a lot)
  state.doseMsv += balance.radiation.baseMsvPerSol * sector.radiationMult * shieldingMult(state, data, 'gcr');
  state.doseMsv += speDoseOn(state, state.sol);
  endOfSol(state, data); // storms end, repairs finish, switched-off buildings come back

  // 6. history (the debrief reads this)
  state.history.push({
    sol: state.sol,
    produced,
    demand,
    unpowered: [...new Set(unpowered)],
    cropLost,
    net: {
      oxygen: state.res.oxygen - before.oxygen,
      water: state.res.water - before.water,
      food: state.res.food - before.food,
    },
    res: { ...state.res },
    doseMsv: state.doseMsv,
  });

  // 7. failure / success
  const { habitatWindowSols, habitatUnpoweredLimit } = balance.failure;
  const habCold = state.history.slice(-habitatWindowSols).filter((h) => h.unpowered.includes('habitat')).length;
  let cause = null;
  if (state.res.oxygen < 0) cause = 'oxygen';
  else if (state.res.water < 0) cause = 'water';
  else if (state.res.food < 0) cause = 'food';
  else if (habCold >= habitatUnpoweredLimit) cause = 'habitat_power';
  else if (state.doseMsv > balance.radiation.doseBudgetMsv) cause = 'radiation';
  for (const k of ['oxygen', 'water', 'food']) if (state.res[k] < 0) state.res[k] = 0;

  if (cause) {
    state.status = 'failed';
    state.failure = { cause, sol: state.sol };
    events.push({ type: 'failed', cause });
  } else if (state.sol >= balance.mission.lengthSols) {
    state.status = 'complete';
    events.push({ type: 'complete' });
  }
  return events;
}