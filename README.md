# Vyoma: Mars Outpost Trainer

NASA Space Apps 2026 entry: *Build a Junior Astronaut Mission Trainer*.

## Run it
```
npm install
npm run dev      # local dev server with hot reload
npm test         # balance tests: plays scripted strategies through the real sim
npm run build    # production build into dist/ (upload to GitHub Pages / Netlify)
```

## Where things live
| Path | What | Who edits |
|---|---|---|
| `src/data/*.json` | every number, sector, building and line of player-facing text | designers |
| `src/sim/` | the simulation rules (pure JS, no Phaser) and the debrief generator | dev |
| `src/game/controller.js` | game clock and state owner | dev |
| `src/scenes/OutpostScene.js` | isometric map, tap-to-build, pan/zoom | dev |
| `src/ui/hud.js` + `src/styles.css` | all HTML UI on top of the map | dev + designer |
| `tests/sim.test.mjs` | balance checks: run after ANY number change | everyone |

## Rule for changing numbers
Change a JSON value, then run `npm test`. If a test fails, the balance broke: either fix the number or
update the test plan on purpose and say why in the commit.

## Science sources
Notes starting with `_` in the JSON files say where each real number comes from. Anything marked APPROX must be
verified against NASA's Baseline Values and Assumptions Document (BVAD) before the demo.
