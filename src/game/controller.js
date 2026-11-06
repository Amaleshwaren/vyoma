// owns the game state and the sol clock. the scene and HUD talk to the sim only through this.
//
// each sol goes: briefing (paused, task shown) -> running (live clock) -> fastforward (after 'end sol')
// -> report (paused, results shown) -> [decision, if a mars event was rolled] -> briefing for the next sol.
// 'paused' is the player's pause button.
import { bus } from '../bus.js';
import { createState, tick, advanceTime, placeBuilding, demolishBuilding, sendRover, projectSol } from '../sim/sim.js';
import { assignTask, checkTask, closeTask, getTaskDef } from '../sim/tasks.js';
import { buildDebrief } from '../sim/debrief.js';
import { rollEvent, describePending, choose, repairBuilding, addShielding } from '../sim/events.js';

export class GameController {
  constructor(data) {
    this.data = data;
    this.state = null;
    this.projection = null; // end-of-sol state if nothing changes: drives the smooth display
    this.phase = 'briefing';
    this.acc = 0; // ms into the current sol
    this.ffRate = 1;
  }

  newGame(sectorId) {
    this.state = createState(sectorId, this.data);
    this.acc = 0;
    this.solEvents = []; // things that happened mid-sol (rovers home, finds), shown again in the report
    assignTask(this.state, this.data);
    this.refresh();
    bus.emit('new-game', this.state);
    this.setPhase('briefing');
    bus.emit('state', this.state);
  }

  setPhase(phase) {
    this.phase = phase;
    bus.emit('phase', phase);
  }

  get currentTask() {
    const cur = this.state?.tasks.current;
    return cur ? { ...cur, def: getTaskDef(this.data, cur.id) } : null;
  }

  // ---------- sol flow ----------

  startSol() {
    if (this.phase === 'briefing' && this.state.status === 'playing') this.setPhase('running');
  }

  togglePause() {
    if (this.phase === 'running') this.setPhase('paused');
    else if (this.phase === 'paused') this.setPhase('running');
  }

  endSolEarly() {
    if (this.phase !== 'running' && this.phase !== 'paused') return;
    const msPerSol = this.data.balance.mission.msPerSol;
    this.ffRate = Math.max(1, (msPerSol - this.acc) / this.data.balance.mission.fastForwardMs);
    this.setPhase('fastforward');
  }

  // called every frame by the scene with the frame time in ms
  update(deltaMs) {
     if (this.phase !== 'running' && this.phase !== 'fastforward') return;
    const msPerSol = this.data.balance.mission.msPerSol;
    // cap the step so switching tabs and coming back doesn't jump a whole sol
    // fast-forward uses real elapsed time so 'end sol' takes the same ~2.5 s on slow machines too
    const step = this.phase === 'fastforward' ? deltaMs * this.ffRate : Math.min(deltaMs, 1000); // cap: coming back to a hidden tab
    this.acc += step;
    if (this.acc >= msPerSol) return this.finishSol(); // tick() plays out whatever is left of the sol

    // play out this slice of the sol: rovers drive and deliver, new finds get spotted
    const events = advanceTime(this.state, this.data, step / msPerSol);
    if (events.length) {
      this.solEvents.push(...events);
      for (const e of events) bus.emit('sim-event', e);
      const completed = checkTask(this.state, this.data);
      this.refresh();
      if (completed) bus.emit('task-complete', completed);
      bus.emit('state', this.state);
    }
  }

  finishSol() {
    const { state, data } = this;
    this.acc = 0;
    const events = [...this.solEvents, ...tick(state, data)];
    this.solEvents = [];
    const completed = checkTask(state, data); // some tasks can only be judged once the sol is over
    if (completed) bus.emit('task-complete', completed);
    const task = closeTask(state);
    const h = state.history.at(-1);

    if (state.status !== 'playing') {
      this.refresh();
      this.setPhase('ended');
      bus.emit('tick', state);
      bus.emit('ended', buildDebrief(state, data));
      return;
    }

    const next = assignTask(state, data);
    rollEvent(state, data);
    this.refresh();
    this.setPhase('report');
    bus.emit('tick', state);
    bus.emit('sol-report', {
      sol: h.sol,
      net: h.net,
      produced: h.produced,
      demand: h.demand,
      unpowered: h.unpowered,
      cropLost: h.cropLost,
      events,
      task: task ? { def: getTaskDef(data, task.id), done: task.done } : null,
      next,
    });
  }

  // the report closes into the next sol's briefing
  closeReport() {
    if (this.phase === 'report') return;
    if (this.state.events.pending) {
      this.setPhase('decision');
      bus.emit('decision', describePending(this.state, this.data));
    } else this.setPhase('briefing');
  }

  get pendingDecision() {
    return describePending(this.state, this.data);
  }

  decide(choiceId) {
    const r = choose(this.state, this.data, choiceId);
    if (!r.ok) return r;
    this.refresh();
    this.setPhase('briefing');
    bus.emit('state', this.state);
    return r;
  }

  // 0..1: how far we are into the current sol (rovers, clock and resource bars use this)
  solFraction() {
    return this.acc / this.data.balance.mission.msPerSol;
  }

  // ---------- player actions ----------

  refresh() {
    this.projection = projectSol(this.state, this.data);
  }

  afterAction(result) {
    if (!result.ok) return result;
    const completed = checkTask(this.state, this.data);
    this.refresh();
    if (completed) bus.emit('task-complete', completed);
    bus.emit('state', this.state);
    return result;
  }

  place(type, x, y) {
    return this.afterAction(placeBuilding(this.state, this.data, type, x, y));
  }

  demolish(x, y) {
    return this.afterAction(demolishBuilding(this.state, this.data, x, y));
  }

  sendRover(nodeId) {
    return this.afterAction(sendRover(this.state, this.data, nodeId));
  }

  repair(buildingId) {
    return this.afterAction(repairBuilding(this.state, this.data, buildingId));
  }

  shield() {
    return this.afterAction(addShielding(this.state, this.data));
  }
}