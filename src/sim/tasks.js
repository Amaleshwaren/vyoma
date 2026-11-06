// mission control tasks. pure javascript like the sim, so it's testable in node.
// one task per sol: urgent reactive first, then that sol's scripted task, then the next unused general task.
import { previewPower, projectSol } from './sim.js';

const countOf = (state, type, poweredOnly) =>
  state.buildings.filter((b) => b.type === type && (!poweredOnly || b.powered)).length;

const solsLeft = (state, proj, resource) => {
  const net = proj.history.at(-1)?.net[resource] ?? 0;
  return net >= 0 ? Infinity : state.res[resource] / -net;
};

export function allTaskDefs(data) {
  const t = data.tasks;
  return [...t.reactive, ...t.scripted, ...t.general];
}

export function getTaskDef(data, id) {
  return allTaskDefs(data).find((d) => d.id === id) ?? null;
}

// is a 'done' or 'when' condition true right now? proj = projected end-of-sol state
function evaluate(cond, state, proj, data, baseline = {}) {
  const power = () => {
    const p = previewPower(state, data);
    return p.produced - p.demand;
  };
  switch (cond.type) {
    case 'hasBuilding':
      // 'powered' is judged on the projection: will it still have power at the end of the sol?
      return countOf(cond.powered ? proj : state, cond.building, cond.powered) >= (cond.count ?? 1);
    case 'buildMore':
      return countOf(state, cond.building) >= (baseline.count ?? 0) + (cond.count ?? 1);
    case 'roverSent':
      return (
        state.rovers.some((r) => r.job?.nodeType === cond.node) ||
        (state.stats.cleared[cond.node] ?? 0) > (baseline.cleared ?? 0)
      );
    case 'powerBalance':
      return power() >= cond.min;
    case 'powerBalanceBelow':
      return power() < cond.value;
    case 'resourceAtLeast':
      return state.res[cond.resource] >= cond.value;
    case 'projectedNetAtLeast':
      return (proj.history.at(-1)?.net[cond.resource] ?? 0) >= cond.value;
    case 'solsLeftBelow':
      return solsLeft(state, proj, cond.resource) < cond.value;
    default:
      throw new Error(`unknown task condition: ${cond.type}`);
  }
}

function baselineFor(def, state) {
  const d = def.done;
  return {
    count: d.building ? countOf(state, d.building) : 0,
    cleared: d.node ? state.stats.cleared[d.node] ?? 0 : 0,
  };
}

// pick the task for the sol that's about to start
export function assignTask(state, data) {
  const sol = state.sol + 1;
  const proj = projectSol(state, data);
  const used = new Set(state.tasks.log.map((l) => l.id));
  const t = data.tasks;
  const candidates = [
    ...t.reactive.filter((d) => evaluate(d.when, state, proj, data)),
    ...t.scripted.filter((d) => d.sol === sol),
    ...t.general.filter((d) => !used.has(d.id)),
  ];
  const def = candidates.find((d) => !evaluate(d.done, state, proj, data, baselineFor(d, state)));
  state.tasks.current = def ? { id: def.id, sol, baseline: baselineFor(def, state), done: false } : null;
  return def ?? null;
}

// call after any player action and at the end of a sol. grants the reward once.
export function checkTask(state, data) {
  const cur = state.tasks.current;
  if (!cur || cur.done || state.status !== 'playing') return null;
  const def = getTaskDef(data, cur.id);
  const proj = projectSol(state, data);
  if (!evaluate(def.done, state, proj, data, cur.baseline)) return null;
  cur.done = true;
  state.res.metal += def.reward?.metal ?? 0;
  return def;
}

// end of sol: record the result and clear it
export function closeTask(state) {
  const cur = state.tasks.current;
  if (cur) state.tasks.log.push({ sol: cur.sol, id: cur.id, done: cur.done });
  state.tasks.current = null;
  return cur;
}