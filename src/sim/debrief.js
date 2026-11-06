// all wording lives in data/debrief.json; this file only works out the numbers.
import { getDef, getSector } from './sim.js';
import { getTaskDef } from './tasks.js';
import { eventDef } from './events.js';

// one plain-language line per event, e.g. "A dust storm on sols 12 to 15 cut your solar power to 30%."
function eventLines(state, data, logs) {
  return logs.map((l) => {
    const d = eventDef(data, l.type);
    return fill(d.debrief, {
      sol: l.sol,
      from: l.from,
      to: l.to,
      pct: Math.round((d.solarMult ?? 1) * 100),
      dose: l.dose,
      building: l.building ? getDef(data, l.building).name : '',
    });
  });
}

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
const r1 = (n) => Math.round(n * 10) / 10;
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const RESOURCES = ['oxygen', 'water', 'food'];

export function buildDebrief(state, data) {
  const t = data.debrief;
  const { balance } = data;
  const sector = getSector(data, state.sectorId);
  const nameOf = (id) => getDef(data, id).name;

  const vars = {
    sol: state.sol,
    crew: state.crew,
    sector: sector.name,
    dose: r1(state.doseMsv),
    budget: balance.radiation.doseBudgetMsv,
    mult: sector.radiationMult,
    built: state.buildings.length - 1, // minus the habitat you landed with
    scavenged: Math.round(state.metalScavenged),
    tasksDone: state.tasks.log.filter((l) => l.done).length,
    tasksTotal: state.tasks.log.length,
  };

  if (state.status === 'complete') {
    const s = t.score;
    const earned = [
      [true, s.survived],
      [vars.tasksTotal > 0 && vars.tasksDone / vars.tasksTotal >= 0.6, s.tasks],
      [state.doseMsv <= balance.radiation.doseBudgetMsv * 0.6, s.radiation],
    ];
    const stars = earned.map(([ok]) => (ok ? '★' : '☆')).join('');
    const why = earned.filter(([ok]) => ok).map(([, label]) => label).join(', ');
    return {
      outcome: 'complete',
      headline: fill(t.complete.headline, vars),
      lines: [fill(s.line, { stars }) + ` (${why})`, ...t.complete.lines.map((l) => fill(l, vars))],
      lesson: t.complete.lesson,
    };
  }

  const cause = state.failure.cause;
  const c = t.causes[cause];
  const lines = [];
  vars.sol = state.failure.sol;

  if (RESOURCES.includes(cause)) {
    vars.need = r1(state.crew * balance.crewPerSol[cause]);
    vars.resource = cause;
    lines.push(fill(c.need, vars));

    const hasMain = state.buildings.some((b) => c.mainProducers.includes(b.type));
    if (!hasMain) {
      lines.push(fill(c.neverBuilt, { ...vars, names: c.mainProducers.map(nameOf).join(' or ') }));
    } else {
      const starved = state.history.filter((h) => h.unpowered.some((u) => c.producers.includes(u)));
      if (starved.length) {
        const types = [...new Set(starved.flatMap((h) => h.unpowered.filter((u) => c.producers.includes(u))))];
        lines.push(
          fill(t.shared.noPower, {
            names: types.map(nameOf).join(' and '),
            n: starved.length,
            needed: r1(avg(starved.map((h) => h.demand))),
            made: r1(avg(starved.map((h) => h.produced))),
          })
        );
      }
      const recent = state.history.slice(-10);
      const loss = r1(-avg(recent.map((h) => h.net[cause])));
      if (loss > 0) lines.push(fill(t.shared.notEnough, { ...vars, k: recent.length, loss }));
    }

    if (cause === 'food') {
      const lost = state.history.reduce((a, h) => a + h.cropLost, 0);
      const gh = data.buildings.find((b) => b.id === 'greenhouse');
      if (lost) lines.push(fill(c.cropLost, { n: lost, grow: gh?.growSols ?? '?' }));
    }
  } else if (cause === 'habitat_power') {
    const w = balance.failure.habitatWindowSols;
    const streak = state.history.slice(-w).filter((h) => h.unpowered.includes('habitat'));
    lines.push(
      ...c.lines.map((l) =>
        fill(l, {
          n: streak.length,
          w,
          needed: r1(avg(streak.map((h) => h.demand))),
          made: r1(avg(streak.map((h) => h.produced))),
        })
      )
    );
  } else {
    lines.push(...c.lines.map((l) => fill(l, vars)));
  }

  // events that played a part: every solar storm for radiation, otherwise anything in the last 10 sols
  // plus any breakdown of a building that makes the resource that ran out, however long ago
  const recent = state.events.log.filter((l) => l.sol >= state.failure.sol - 10).slice(-3);
  const brokeProducer = state.events.log.filter((l) => l.type === 'equipment_failure' && c.producers?.includes(l.building));
  const relevant =
    cause === 'radiation'
      ? state.events.log.filter((l) => l.type === 'solar_particle_event')
      : [...new Set([...brokeProducer, ...recent])].sort((a, b) => a.sol - b.sol);
  lines.push(...eventLines(state, data, relevant).map((line, i) => (relevant[i].choice === 'leave' ? line + t.shared.leftBroken : line)));

  // the first task mission control gave about this exact problem, if the player skipped it
  const skipped = state.tasks.log.find((l) => !l.done && getTaskDef(data, l.id)?.relatesTo === cause);
  if (skipped) lines.push(fill(t.shared.skippedTask, { sol: skipped.sol, title: getTaskDef(data, skipped.id).title }));

  return { outcome: 'failed', headline: fill(c.headline, vars), lines, lesson: c.lesson };
}