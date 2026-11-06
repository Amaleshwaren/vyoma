import Phaser from 'phaser';
import './styles.css';
import balance from './data/balance.json';
import sectors from './data/sectors.json';
import buildings from './data/buildings.json';
import nodes from './data/nodes.json';
import debrief from './data/debrief.json';
import tasks from './data/tasks.json';
import events from './data/events.json';
import tutorial from './data/tutorial.json';
import { GameController } from './game/controller.js';
import { OutpostScene } from './scenes/OutpostScene.js';
import { initHud } from './ui/hud.js';
import { initTutorial, tutorialDone } from './ui/tutorial.js';

const data = {
  balance,
  sectors: sectors.sectors,
  buildings: buildings.buildings,
  nodes: nodes.nodes,
  debrief,
  tasks,
  events,
  tutorial,
};

const controller = new GameController(data);

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#140d12',
  scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
  scene: [],
});
game.scene.add('Outpost', OutpostScene, false);

function startGame(sectorId) {
  const go = () => {
    // stop first so the old map isn't redrawn with the new sector's state
    if (game.scene.isActive('Outpost') || game.scene.isPaused('Outpost')) game.scene.stop('Outpost');
    controller.newGame(sectorId);
    game.scene.start('Outpost', { controller });
    if (document.getElementById('tutorial-toggle').checked) guide.start();
    else guide.stop();
  };
  if (game.isBooted) go();
  else game.events.once('ready', go);
}

initHud({ controller, data, startGame });
const guide = initTutorial({ controller, data });
document.getElementById('tutorial-toggle').checked = !tutorialDone(); // on for first-timers

// open the game with ?debug in the URL to poke at it from the browser console: vyoma.controller.state
if (new URLSearchParams(location.search).has('debug')) window.vyoma = { controller, game };