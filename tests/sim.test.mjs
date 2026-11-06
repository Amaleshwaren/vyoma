// run with: npm test
// plays scripted strategies through the real sim and checks the balance makes sense:
// doing nothing must fail fast, a sensible build must survive, a bad build must fail with the right reason.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createState, tick, placeBuilding, findFreeSpotNear, sendRover, planTrip, getNodeDef, getDef, sizeOf, buildingAt, demolishBuilding, canPlace } from '../src/sim/sim.js';
import { buildDebrief } from '../src/sim/debrief.js';
import { assignTask, checkTask, closeTask } from '../src/sim/tasks.js';
import { rollEvent, describePending, choose, solarFactor, addShielding } from '../src/sim/events.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../src/data/${f}`, import.meta.url)));
const data = {
  balance: load('balance.json'),
  sectors: load('sectors.json').sectors,
  buildings: load('buildings.json').buildings,
  nodes: load('nodes.json').nodes,
  debrief: load('debrief.json'),
  tasks: load('tasks.json'),
  events: load('events.json'),
};

// place a building on the nearest free tile to the habitat
function build(state, type) {
  const { w, h } = sizeOf(getDef(data, type));
  const spot = findFreeSpotNear(state, state.grid.habitat.x, state.grid.habitat.y, w, h);
  return spot ? placeBuilding(state, data, type, spot.x, spot.y) : { ok: false, reason: 'no space' };
}

// a "decent player": keeps every idle rover busy on the best metal-per-sol node,
// and builds the plan in order as soon as it can afford each item
// a sensible player's answer to each decision card: first option that's available, in this order
const PREFER = ['shelter', 'pile_regolith', 'repair_now', 'repair_slow', 'shut_drill', 'ride_out', 'take_it', 'leave'];
function autoChoose(s) {
  const d = describePending(s, data);
  if (!d) return;
  const pick = PREFER.map((id) => d.choices.find((c) => c.id === id && c.ok)).find(Boolean);
  choose(s, data, pick.id);
}

function run(sectorId, plan, { scavenge = true, events = true } = {}) {
  const s = createState(sectorId, data);
  const queue = plan.flatMap(([type, n]) => Array(n).fill(type));
  let finishedSol = null;
  while (s.status === 'playing') {
    if (scavenge) {
      for (const r of s.rovers.filter((r) => !r.job)) {
        const best = s.nodes
          .filter((n) => !n.claimedBy)
          .map((n) => {
            // value regolith highly only while the next thing to build needs it
            const y = getNodeDef(data, n.type).yield;
            const needRegolith = queue.length && (getDef(data, queue[0]).cost?.regolith ?? 0) > s.res.regolith;
            const value = (y.metal ?? 0) + (y.regolith ?? 0) * (needRegolith ? 3 : 0.2);
            return { n, rate: value / planTrip(s, data, n).hours };
          })
          .sort((a, b) => b.rate - a.rate)[0];
        if (best) sendRover(s, data, best.n.id);
      }
    }
    while (queue.length) {
      const r = build(s, queue[0]);
      if (!r.ok) break;
      queue.shift();
    }
    if (!queue.length && finishedSol === null) finishedSol = s.sol;
    if (events) {
      rollEvent(s, data);
      autoChoose(s);
    }
    tick(s, data);
  }
  return { s, debrief: buildDebrief(s, data), finishedSol, unbuilt: queue };
}


const report = (label, { s, debrief, finishedSol, unbuilt }) => {
  const plan = finishedSol === null ? `never finished building (stuck on ${unbuilt[0]})` : `plan built by sol ${finishedSol}`;
  const evs = s.events.log.map((l) => l.type.split('_').map((w) => w[0]).join('')).join(' ');
  console.log(`  ${label}: ${s.status} on sol ${s.sol} | ${plan} | metal left ${Math.floor(s.res.metal)}, dose ${s.doseMsv.toFixed(0)} | events: ${evs || 'none'}`);
  if (s.status === 'failed') console.log(`     -> ${debrief.headline}\n     -> ${debrief.lines.join('\n     -> ')}`);
  return s;
};

console.log('\n1. doing nothing must fail early:');
for (const sec of data.sectors) {
  const r = run(sec.id, [], { scavenge: false, events: false });
  report(sec.id, r);
  assert.equal(r.s.status, 'failed');
  assert.ok(r.s.sol < 25, 'idle base should die within ~3 weeks of sols');
}

console.log('\n2. without scavenging, starting metal must NOT be enough for a full base:');
const noScav = run('crater_rim', [['solar_array', 6], ['oxygen_plant', 1], ['water_extractor', 1], ['water_recycler', 1], ['greenhouse', 2]], { scavenge: false, events: false });
report('crater, no scavenging', noScav);
assert.notEqual(noScav.s.status, 'complete');

console.log('\n3. a sensible build + scavenging must survive in every sector:');
// order matters: oxygen first, then food (crops take time), then water. every base starts with 2 solar + 1 battery.
// these plans also prepare for events: spare power, extra batteries and a storm shelter.
const core = [['solar_array', 1], ['oxygen_plant', 1], ['solar_array', 2], ['greenhouse', 1], ['solar_array', 2], ['water_extractor', 1], ['water_recycler', 1]];
const backup = [['battery', 2], ['greenhouse', 1], ['storm_shelter', 1]];
const plans = {
  ice_basin: [...core, ['fission_reactor', 1], ...backup], // weak sun + storms: needs nuclear backup
  sunny_highlands: [...core, ['solar_array', 2], ...backup],
  crater_rim: [...core, ['solar_array', 4], ...backup],
  dust_flats: [...core, ['fission_reactor', 1], ...backup],
  iron_ridge: [...core, ['solar_array', 4], ...backup],
  // lava tube: solar is useless, so the reactor has to come first or the oxygen plant can't even run
  lava_tube: [['fission_reactor', 1], ['oxygen_plant', 1], ['greenhouse', 2], ['water_extractor', 1], ['solar_array', 4], ['water_recycler', 1], ['battery', 2], ['storm_shelter', 1]],
};
for (const [sec, plan] of Object.entries(plans)) {
  const s = report(sec, run(sec, plan));
  assert.equal(s.status, 'complete', `${sec} sensible plan should survive`);
}

console.log('\n4. lava tube: solar alone must NOT work:');
const lavaSolar = run('lava_tube', [['oxygen_plant', 1], ['solar_array', 20], ['greenhouse', 2]]);
report('lava solar', lavaSolar);
assert.notEqual(lavaSolar.s.status, 'complete');

console.log('\n5. underpowered greenhouses must starve the crew, and the debrief must say power:');
const starve = run('crater_rim', [['solar_array', 1], ['oxygen_plant', 1], ['water_extractor', 1], ['water_recycler', 1], ['greenhouse', 2]]);
report('starve', starve);
assert.equal(starve.s.failure?.cause, 'food');
assert.ok(starve.debrief.lines.some((l) => l.includes('no power')), 'debrief should blame power');

console.log('\n6. rover trips are paid from the battery: no charge, no trip:');
{
  const s = createState('crater_rim', data);
  const node = s.nodes.find((n) => n.type === 'meteorite');
  const trip = planTrip(s, data, node);
  const before = s.res.battery;
  const r = sendRover(s, data, node.id);
  console.log(`  trip ${trip.hours.toFixed(1)} Mars hours, cost ${trip.kWh} kWh: battery ${before} -> ${s.res.battery}`);
  assert.ok(r.ok);
  assert.equal(s.res.battery, before - trip.kWh);
  const s2 = createState('crater_rim', data);
  s2.res.battery = 0;
  const r2 = sendRover(s2, data, s2.nodes.find((n) => n.type === 'meteorite').id);
  console.log(`  empty battery -> ${r2.reason}`);
  assert.equal(r2.ok, false);
}

console.log('\n7. discovery: a new meteorite appears far out every few sols, but never past the cap:');
{
  const cfg = data.balance.discovery;
  const s = createState('crater_rim', data);
  s.nodes = s.nodes.filter((n) => n.type === 'boulder'); // pretend all metal is gone
  Object.assign(s.res, { oxygen: 1e6, water: 1e6, food: 1e6 }); // keep the crew alive so we can watch 200 sols
  tick(s, data); // one sol = 24 Mars hours
  const found = s.nodes.filter((n) => n.type === cfg.type);
  const { x: hx, y: hy } = s.grid.habitat;
  console.log(`  after ${s.sol} sols: ${found.length} found, distance ${found.map((n) => Math.hypot(n.x - hx, n.y - hy).toFixed(1)).join(', ')}`);
  assert.equal(found.length, Math.min(cfg.maxActive, Math.floor(24 / cfg.everyHours)));
  assert.ok(Math.hypot(found[0].x - hx, found[0].y - hy) >= cfg.minDistance);
  for (let i = 0; i < 40; i++) if (s.status === 'playing') tick(s, data);
  const active = s.nodes.filter((n) => n.type !== 'boulder' && !n.claimedBy).length;
  console.log(`  after ${s.sol} sols: ${active} unclaimed metal nodes (cap ${cfg.maxActive})`);
  assert.ok(active <= cfg.maxActive);
}

console.log('\n8. tasks: assign, complete with reward, skip, and urgent tasks jump the queue:');
{
  const s = createState('crater_rim', data);
  const first = assignTask(s, data);
  assert.equal(first.id, 'build_oxygen');
  assert.equal(checkTask(s, data), null, 'not done yet');
  build(s, 'solar_array');
  build(s, 'oxygen_plant');
  const before = s.res.metal;
  const done = checkTask(s, data);
  assert.equal(done?.id, 'build_oxygen');
  const reward = s.res.metal - before;
  console.log(`  sol 1: '${done.title}' done, reward ${reward} metal`);
  assert.equal(reward, done.reward.metal);
  assert.equal(checkTask(s, data), null, 'reward is only paid once');
  closeTask(s);
  tick(s, data);
  const second = assignTask(s, data);
  closeTask(s); // skipped
  console.log(`  sol 2: '${second.title}' skipped -> log: ${JSON.stringify(s.tasks.log)}`);
  assert.equal(s.tasks.log.at(-1).done, false);

  const s2 = createState('crater_rim', data); // no oxygen plant, so 5 kg really is an emergency
  s2.res.oxygen = 5;
  const urgent = assignTask(s2, data);
  console.log(`  oxygen at 5 kg -> task '${urgent.title}'`);
  assert.equal(urgent.relatesTo, 'oxygen');
}

console.log('\n9. a skipped task shows up in the failure debrief:');
{
  const s = createState('crater_rim', data);
  assignTask(s, data); // 'make your own air'
  closeTask(s); // skipped
  while (s.status === 'playing') tick(s, data);
  const d = buildDebrief(s, data);
  const line = d.lines.find((l) => l.includes('mission control asked'));
  console.log(`  ${line}`);
  assert.ok(line);
}

console.log('\n10. footprints: big buildings block every tile they cover:');
{
  const s = createState('crater_rim', data);
  const hab = s.buildings.find((b) => b.type === 'habitat');
  const covered = [];
  for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) covered.push(buildingAt(s, hab.x + dx, hab.y + dy) === hab);
  console.log(`  habitat at (${hab.x},${hab.y}) covers ${covered.filter(Boolean).length}/9 tiles`);
  assert.ok(covered.every(Boolean));
  const r = build(s, 'oxygen_plant');
  assert.ok(r.ok);
  const o = r.building;
  const overlap = canPlace(s, data, 'solar_array', o.x + 1, o.y + 1);
  console.log(`  overlapping 2x2 -> ${overlap.reason}`);
  assert.equal(overlap.ok, false);
  const d = demolishBuilding(s, data, o.x + 1, o.y + 1); // tap any tile of it
  assert.ok(d.ok);
  assert.equal(buildingAt(s, o.x, o.y), null);
}

console.log('\n11. dust storm: solar drops during the storm, panels stay dusty after, and wind slowly cleans them:');
{
  const s = createState('dust_flats', data);
  s.sol = 5;
  s.events.pending = { type: 'dust_storm', sol: 6, length: 3 };
  s.events.lastSol = 6;
  choose(s, data, 'ride_out');
  const during = solarFactor(s, data, 7);
  for (let i = 0; i < 4; i++) tick(s, data); // sols 6..9: storm is sols 7..9
  const after = solarFactor(s, data, s.sol + 1);
  for (let i = 0; i < 6; i++) tick(s, data);
  const later = solarFactor(s, data, s.sol + 1);
  console.log(`  solar x${during} during, x${after.toFixed(2)} right after, x${later.toFixed(2)} six sols later`);
  assert.equal(during, 0.5);
  assert.ok(after < 1 && later > after && later <= 1);
}

console.log('\n12. solar particle event: shelter and shielding really cut the dose:');
{
  const dose = (setup, choice) => {
    const s = createState('sunny_highlands', data);
    setup(s);
    s.events.pending = { type: 'solar_particle_event', sol: 1 };
    choose(s, data, choice);
    const before = s.doseMsv;
    tick(s, data);
    return s.doseMsv - before;
  };
  const none = dose(() => {}, 'take_it');
  const shield = dose((s) => (s.res.regolith = 30), 'pile_regolith');
  const shelter = dose((s) => {
    s.res.metal = 999;
    s.res.regolith = 99;
    const r = build(s, 'storm_shelter');
    assert.ok(r.ok, r.reason);
  }, 'shelter');
  console.log(`  dose that sol: unshielded ${none.toFixed(1)}, +1 regolith layer ${shield.toFixed(1)}, in shelter ${shelter.toFixed(1)} mSv`);
  assert.ok(shelter < shield && shield < none);
}

console.log('\n13. equipment failure: broken buildings stop, repairs fix them, the debrief names the event:');
{
  const s = createState('crater_rim', data);
  build(s, 'solar_array');
  const plant = build(s, 'oxygen_plant').building;
  plant.broken = true;
  s.events.pending = { type: 'equipment_failure', sol: 1, buildingId: plant.id };
  const d = describePending(s, data);
  console.log(`  card: "${d.warning}" -> ${d.choices.map((c) => c.id + (c.ok ? '' : ' (locked)')).join(', ')}`);
  choose(s, data, 'leave');
  tick(s, data);
  assert.ok(s.history.at(-1).net.oxygen < 0, 'a broken oxygen plant makes nothing');
  while (s.status === 'playing') tick(s, data);
  const db = buildDebrief(s, data);
  console.log(`  ${db.headline}\n  ${db.lines.find((l) => l.includes('broke down')) ?? '(no event line!)'}`);
  assert.ok(db.lines.some((l) => l.includes('broke down')));
}

console.log('\n14. events escalate: none before sol 4, more later in the mission:');
{
  let early = 0;
  let late = 0;
  for (const sec of data.sectors) {
    const s = createState(sec.id, data);
    s.res.metal = 9999;
    for (let sol = 0; sol < 30; sol++) {
      const ev = rollEvent(s, data);
      if (ev) (s.sol + 1 < 15 ? early++ : late++);
      autoChoose(s);
      s.sol += 1;
    }
  }
  console.log(`  events across all 6 sectors: ${early} in sols 1-14, ${late} in sols 15-30`);
  assert.ok(late > early);
}

console.log('\nall good.\n');
