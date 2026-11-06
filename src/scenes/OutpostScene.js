// the top-down (3/4 view) map: draws terrain, scavenge nodes, buildings and rovers, handles taps, pan and zoom.
// it holds no game rules: it asks the controller and redraws when the state changes.
// all art is generated placeholder shapes; the designer's sprites replace them via the texture keys
// (ground_<sector>, cliff_<sector>, bld_<building>, node_<node>, rover). sizes are in the asset spec.
import Phaser from 'phaser';
import { bus } from '../bus.js';
import { canPlace, buildingAt, nodeAt, getDef, getNodeDef, sizeOf, makeRng, hashString } from '../sim/sim.js';
import { stormOn, isOffline } from '../sim/events.js';


const T = 48; // tile size in px (square grid)
const DRAG_THRESHOLD = 6; // px a pointer must move before a tap becomes a pan
const ACTIVE_PHASES = ['briefing', 'running', 'paused']; // when the player may build and send rovers
const PARKING = [
  { dx: -1, dy: 2 },
  { dx: 0, dy: 2 },
  { dx: 1, dy: 2 },
]; // idle rovers sit just below the 3x3 habitat, in tile units from its centre
const START_TILES = 14; // CoC-style: start zoomed in so ~14 tiles fit the short side of the screen

const hexToInt = (hex) => parseInt(hex.replace('#', ''), 16);
const shade = (col, f) => {
  const r = Math.min(255, Math.round(((col >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((col >> 8) & 255) * f));
  const b = Math.min(255, Math.round((col & 255) * f));
  return (r << 16) | (g << 8) | b;
};

export class OutpostScene extends Phaser.Scene {
  constructor() {
    super('Outpost');
  }

  init({ controller }) {
    this.controller = controller;
    this.selected = null; // building type picked in the HUD, or null
    this.demolishMode = false;
    this.dragging = false;
  }

  create() {
    const { state } = this.controller;
    this.sector = this.controller.data.sectors.find((s) => s.id === state.sectorId);
    this.makeTextures();

    const n = state.grid.size;
    this.tileImages = [];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        this.tileImages.push(this.add.image(x * T, y * T, this.tileKey(x, y)).setOrigin(0).setDepth(0));
      }
    }
    // outside the playable map: darker terrain to the horizon, so wide screens never show black edges
    const pad = 60 * T;
    this.add
      .tileSprite(-pad, -pad, n * T + pad * 2, n * T + pad * 2, `ground_${this.sector.id}_1`)
      .setOrigin(0)
      .setDepth(-2)
      .setTint(0x8a8a8a);
    this.add.graphics().setDepth(-1).lineStyle(4, 0x000000, 0.35).strokeRect(-2, -2, n * T + 4, n * T + 4);
    this.addDecorations();
    this.hover = this.add.image(0, 0, 'tile_hover').setOrigin(0).setDepth(1).setVisible(false);
    // ghost: a see-through copy of the building being placed, plus its footprint outline
    this.ghostArea = this.add.graphics().setDepth(2).setVisible(false);
    this.ghost = this.add.image(0, 0, 'tile_hover').setOrigin(0, 1).setAlpha(0.6).setDepth(500).setVisible(false);

    // dust storm haze: a screen-sized orange viel, fixed to the camera, visible only during a storm
    this.haze = this.add
      .rectangle(0, 0, this.scale.width, this.scale.height, 0xc8803c, 0.28)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(900)
      .setVisible(false); // hidden when there's no storm, so it costs nothing to draw
    this.scale.on('resize', (size) => this.haze.setSize(size.width, size.height));

    this.buildingSprites = [];
    this.nodeSprites = new Map(); // node id -> { img, icon }
    this.roverSprites = new Map(); // rover id -> image
    this.syncAll();

    // start zoomed in on the base; scroll the wheel to see the whole map.
    // no camera bounds: on wide screens they pin the map to the left edge, so we clamp the centre ourselves.
    const cam = this.cameras.main;
    this.worldSize = n * T;
    const short = Math.min(this.scale.width, this.scale.height - 160);
    this.minZoom = Math.min(this.scale.width, this.scale.height - 160) / (this.worldSize * 1.05);
    cam.setZoom(Phaser.Math.Clamp(short / (START_TILES * T), this.minZoom, 2));
    cam.centerOn((state.grid.habitat.x + 0.5) * T, (state.grid.habitat.y + 0.5) * T);
    this.scale.on('resize', () => this.clampCamera());

    this.setupInput();

    const unsubs = [
      bus.on('state', () => this.syncAll()),
      bus.on('tick', () => this.syncAll()),
      bus.on('select-building', (type) => {
        this.selected = type;
        this.demolishMode = false;
      }),
      bus.on('demolish-mode', (on) => {
        this.demolishMode = on;
        if (on) this.selected = null;
      }),
    ];
    this.events.once('shutdown', () => unsubs.forEach((u) => u()));
  }

  update(time) {
    // phaser smooths and caps 'delta' when the frame rate drops, which would make game time run slow on
    // weak laptops. We measure real elapsed time from the frame timestamps instead.
    const real = this.lastTime === undefined ? 0 : time - time.lastTime;
    this.lastTime = time;
    this.controller.update(real);
    this.positionRovers();
  }

  // ---------- coordinates ----------

  tileAtPointer(p) {
    const wp = this.cameras.main.getWorldPoint(p.x, p.y);
    const x = Math.floor(wp.x / T);
    const y = Math.floor(wp.y / T);
    const n = this.controller.state.grid.size;
    return x >= 0 && y >= 0 && x < n && y < n ? { x, y } : null;
  }

  tileKey(x, y) {
    const { grid } = this.controller.state;
    const t = grid.terrain[y * grid.size + x];
    if (t === 'cliff') return `cliff_${this.sector.id}`;
    return `ground_${this.sector.id}_${(x * 7 + y * 13) % 3}`; // 3 ground variants so it doesn't look tiled
  }

  // ---------- placeholder art ----------

  makeTextures() {
    const ground = hexToInt(this.sector.groundColour);
    const rock = hexToInt(this.sector.rockColour);

    // ground: flat colour with a few speckles, 3 variants
    for (let v = 0; v < 3; v++) {
      this.makeTexture(`ground_${this.sector.id}_${v}`, T, T, (g) => {
        g.fillStyle(ground, 1).fillRect(0, 0, T, T);
        let seed = 17 + v * 31;
        const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
        for (let i = 0; i < 7; i++) {
          g.fillStyle(shade(ground, 0.8 + rnd() * 0.35), 1).fillCircle(rnd() * T, rnd() * T, 1 + rnd() * 2);
        }
      });
    }

    // cliff: raised dark rock with a lit top edge and a shadowed front
    this.makeTexture(`cliff_${this.sector.id}`, T, T, (g) => {
      g.fillStyle(shade(ground, 0.5), 1).fillRect(0, 0, T, T);
      g.fillStyle(shade(rock, 0.75), 1).fillRect(2, 2, T - 4, T - 14);
      g.fillStyle(shade(rock, 1.1), 1).fillRect(2, 2, T - 4, 6);
      g.fillStyle(shade(rock, 0.45), 1).fillRect(2, T - 12, T - 4, 10);
    });

    // white so it can be tinted green / red / yellow
    this.makeTexture('tile_hover', T, T, (g) => {
      g.fillStyle(0xffffff, 0.2).fillRect(0, 0, T, T);
      g.lineStyle(3, 0xffffff, 0.9).strokeRect(1.5, 1.5, T - 3, T - 3);
    });

    // buildings: 3/4 view boxes. roof on top, darker front wall below it.
    // texture is T wide; the bottom of the texture sits on the bottom edge of the tile.
    // texture covers the whole footprint; its bottom edge sits on the footprint's bottom edge,
    // and the front wall makes the roof stick up over the row above (3/4 view)
    for (const def of this.controller.data.buildings) {
      const col = hexToInt(def.colour);
      const { w, h } = sizeOf(def);
      const W = w * T;
      const front = Math.round(8 + (def.height ?? 16) * 0.6); // taller buildings show more wall
      const roof = h * T - 10;
      this.makeTexture(`bld_${def.id}`, W, roof + front + 4, (g) => {
        g.fillStyle(0x000000, 0.25).fillEllipse(W / 2, roof + front, W - 4, 12); // ground shadow
        g.fillStyle(shade(col, 0.6), 1).fillRoundedRect(5, roof - 6, W - 10, front + 4, 5); // front wall
        g.fillStyle(col, 1).fillRoundedRect(5, 2, W - 10, roof - 4, 8); // roof
        g.lineStyle(2, shade(col, 0.45), 1).strokeRoundedRect(5, 2, W - 10, roof - 4, 8);
        g.fillStyle(0xf29b38, 1).fillRect(5, roof + front / 2 - 4, W - 10, 3); // orange trim like the mockup
        if (def.solar) {
          // panel grid so solar arrays read as solar arrays
          g.lineStyle(1, 0x9fb7ff, 0.6);
          for (let gx = 12; gx < W - 8; gx += 10) g.lineBetween(gx, 6, gx, roof - 6);
          for (let gy = 12; gy < roof - 6; gy += 10) g.lineBetween(9, gy, W - 9, gy);
        }
      });
    }

    // decorations: visual only, never block anything
    this.makeTexture('deco_crater', T, T, (g) => {
      g.fillStyle(shade(ground, 0.8), 1).fillEllipse(T / 2, T / 2, T - 10, T - 18);
      g.fillStyle(shade(ground, 0.65), 1).fillEllipse(T / 2, T / 2 + 2, T - 18, T - 26);
      g.lineStyle(2, shade(ground, 1.15), 0.8).strokeEllipse(T / 2, T / 2, T - 10, T - 18);
    });
    this.makeTexture('deco_pebbles', T, T, (g) => {
      for (const [x, y, r] of [[12, 30, 3], [20, 34, 2], [30, 28, 4], [36, 36, 2], [26, 18, 2]]) {
        g.fillStyle(shade(rock, 0.8), 1).fillCircle(x, y, r);
      }
    });

    // scavenge nodes (T x T, drawn sitting on the tile)
    const nodeArt = {
      boulder: (g, c) => {
        g.fillStyle(0x000000, 0.25).fillEllipse(T / 2, T - 8, T - 6, 12);
        g.fillStyle(shade(c, 0.7), 1).fillEllipse(T / 2, T / 2 + 6, T - 8, T - 16);
        g.fillStyle(c, 1).fillEllipse(T / 2, T / 2 + 1, T - 12, T - 20);
        g.fillStyle(shade(c, 1.3), 1).fillEllipse(T / 2 - 6, T / 2 - 5, 14, 8);
      },
      meteorite: (g, c) => {
        g.fillStyle(0x000000, 0.25).fillEllipse(T / 2, T - 12, 26, 8);
        g.fillStyle(c, 1).fillPoints([{ x: 14, y: 34 }, { x: 16, y: 20 }, { x: 25, y: 14 }, { x: 35, y: 19 }, { x: 36, y: 33 }, { x: 25, y: 38 }], true);
        g.fillStyle(0xc9ccd6, 1).fillPoints([{ x: 19, y: 20 }, { x: 25, y: 17 }, { x: 29, y: 22 }, { x: 22, y: 25 }], true); // metal sheen
      },
      lander_wreck: (g, c) => {
        g.fillStyle(0x000000, 0.25).fillEllipse(T / 2, T - 10, T - 6, 12);
        g.fillStyle(c, 1).fillPoints([{ x: 4, y: 30 }, { x: 18, y: 12 }, { x: 44, y: 18 }, { x: 34, y: 38 }], true);
        g.fillStyle(0xe0a030, 1).fillPoints([{ x: 16, y: 26 }, { x: 22, y: 18 }, { x: 34, y: 22 }, { x: 28, y: 31 }], true); // gold foil
        g.lineStyle(2, 0x6d717a, 1).lineBetween(8, 30, 4, 16).lineBetween(40, 22, 46, 10); // bent struts
      },
      hematite: (g, c) => {
        g.fillStyle(0x000000, 0.25).fillEllipse(T / 2, T - 10, 30, 8);
        for (const [x, y, r] of [[16, 30, 6], [26, 32, 7], [34, 27, 5], [22, 22, 5], [31, 19, 4]]) {
          g.fillStyle(c, 1).fillCircle(x, y, r);
          g.fillStyle(shade(c, 1.5), 1).fillCircle(x - r / 3, y - r / 3, r / 3);
        }
      },
    };
    for (const nd of this.controller.data.nodes) {
      const draw = nodeArt[nd.id] ?? nodeArt.boulder;
      this.makeTexture(`node_${nd.id}`, T, T, (g) => draw(g, hexToInt(nd.colour)));
    }

    // rover seen from above at a slight angle
    this.makeTexture('rover', 30, 26, (g) => {
      g.fillStyle(0x000000, 0.3).fillEllipse(15, 22, 28, 7);
      g.fillStyle(0x2b2b33, 1).fillRect(2, 6, 6, 16).fillRect(22, 6, 6, 16);
      g.fillStyle(0xf2f0ea, 1).fillRoundedRect(6, 3, 18, 18, 3);
      g.fillStyle(0x3a5fcd, 1).fillRect(9, 6, 12, 7); // solar deck
      g.fillStyle(0xf29b38, 1).fillRect(6, 16, 18, 3);
    });
  }

  addDecorations() {
    const { state } = this.controller;
    const n = state.grid.size;
    const rng = makeRng(hashString(`${state.sectorId}-deco`));
    const { x: hx, y: hy } = state.grid.habitat;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (Math.hypot(x - hx, y - hy) < 3) continue;
        const roll = rng();
        if (roll < 0.03) this.add.image(x * T, y * T, 'deco_crater').setOrigin(0).setDepth(0.5);
        else if (roll < 0.12) this.add.image(x * T, y * T, 'deco_pebbles').setOrigin(0).setDepth(0.5);
      }
    }
  }

  clampCamera() {
    const cam = this.cameras.main;
    const cx = Phaser.Math.Clamp(cam.scrollX + cam.width / 2, 0, this.worldSize);
    const cy = Phaser.Math.Clamp(cam.scrollY + cam.height / 2, 0, this.worldSize);
    cam.scrollX = cx - cam.width / 2;
    cam.scrollY = cy - cam.height / 2;
  }

  makeTexture(key, w, h, draw) {
    if (this.textures.exists(key)) return;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    draw(g);
    g.generateTexture(key, w, h);
    g.destroy();
  }

  // ---------- syncing sprites to state ----------

  syncAll() {
    const storm = stormOn(this.controller.state, this.controller.state.sol + 1);
    this.haze.setVisible(Boolean(storm));
    this.syncTerrain();
    this.syncNodes();
    this.syncBuildings();
    this.syncRovers();
  }

  syncTerrain() {
    const n = this.controller.state.grid.size;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const img = this.tileImages[y * n + x];
        const key = this.tileKey(x, y);
        if (img.texture.key !== key) img.setTexture(key);
      }
    }
  }

  syncNodes() {
    const { state, data } = this.controller;
    const alive = new Set(state.nodes.map((nd) => nd.id));
    for (const [id, s] of this.nodeSprites) {
      if (!alive.has(id)) {
        s.img.destroy();
        s.icon?.destroy();
        this.nodeSprites.delete(id);
      }
    }
    for (const node of state.nodes) {
      let s = this.nodeSprites.get(node.id);
      if (!s) {
        const nd = getNodeDef(data, node.type);
        const img = this.add.image(node.x * T, node.y * T, `node_${nd.id}`).setOrigin(0).setDepth(10 + node.y);
        const icon = nd.showIcon
          ? this.add.text((node.x + 0.5) * T, node.y * T + 2, '🔩', { fontSize: '14px' }).setOrigin(0.5).setDepth(10 + node.y + 0.5)
          : null;
        if (icon && (nd.loads ?? 1) > 1) icon.setStyle({ fontSize: '13px', color: '#ffffff', stroke: '#000000', strokeThickness: 3 });
        s = { img, icon };
        this.nodeSprites.set(node.id, s);
      }
      // a claimed node shows a pickaxe so you can see where rovers are heading
      const nd = getNodeDef(data, node.type);
      const loads = (nd.loads ?? 1) > 1 ? `×${node.loadsLeft}` : '';
      if (node.claimedBy) {
        s.img.setTint(0xfff1b8);
        if (s.icon) s.icon.setText(`⛏️${loads}`);
        else s.icon = this.add.text((node.x + 0.5) * T, node.y * T + 2, '⛏️', { fontSize: '14px' }).setOrigin(0.5).setDepth(10 + node.y + 0.5);
      } else {
        s.img.clearTint();
        if (s.icon && nd.showIcon) s.icon.setText(`🔩${loads}`);
        else if (s.icon) {
          s.icon.destroy();
          s.icon = null;
        }
      }
    }
  }

  syncBuildings() {
    for (const s of this.buildingSprites) {
      s.box.destroy();
      s.icon.destroy();
    }
    this.buildingSprites = [];
    const { state, data } = this.controller;
    for (const b of state.buildings) {
      const def = getDef(data, b.type);
      // bottom-centre of the texture sits on the bottom edge of the footprint, so the roof overlaps the row above (3/4 view)
      const box = this.add
        .image((b.x + b.w / 2) * T, (b.y + b.h) * T, `bld_${def.id}`)
        .setOrigin(0.5, 1)
        .setDepth(10 + b.y + b.h - 1 + 0.2);
      const sol = state.sol + 1;
      let iconText = def.growSols && b.growth < def.growSols ? '🌱' : def.icon;
      if (b.broken) {
        box.setTint(0xb05050); // red = broken
        iconText = '🔧';
      } else if (isOffline(b, sol)) {
        box.setTint(0x555555);
        iconText = '💤'; // switched off for the storm
      } else if (!b.powered) box.setTint(0x555555); // grey = no power
      const icon = this.add
        .text(box.x, box.y - box.height + 20, iconText, { fontSize: b.w > 1 ? '24px' : '18px' })
        .setOrigin(0.5)
        .setAlpha(b.powered ? 1 : 0.5)
        .setDepth(10 + b.y + b.h - 1 + 0.3);
      this.buildingSprites.push({ box, icon });
    }
  }

  syncRovers() {
    const { state } = this.controller;
    const alive = new Set(state.rovers.map((r) => r.id));
    for (const [id, img] of this.roverSprites) {
      if (!alive.has(id)) {
        img.destroy();
        this.roverSprites.delete(id);
      }
    }
    for (const r of state.rovers) {
      if (!this.roverSprites.has(r.id)) this.roverSprites.set(r.id, this.add.image(0, 0, 'rover').setOrigin(0.5, 0.8));
    }
    this.positionRovers();
  }

  // rovers glide between sol ticks: position = how far through the trip they are, in tile coordinates
  positionRovers() {
    const { state } = this.controller;
    const hab = state.grid.habitat;
    let parkIdx = 0;
    for (const r of state.rovers) {
      const img = this.roverSprites.get(r.id);
      if (!img) continue;
      let tx;
      let ty;
      if (!r.job) {
        const p = PARKING[parkIdx++ % PARKING.length];
        tx = hab.x + 0.5 + p.dx;
        ty = hab.y + 0.5 + p.dy;
      } else {
        const j = r.job;
        const e = Math.min(j.hours, j.elapsedH); // advanced every frame by the controller, in Mars hours
        let t;
        let a;
        let b;
        if (e < j.outH) [a, b, t] = [j.from, j.to, e / j.outH];
        else if (e < j.outH + j.workH) [a, b, t] = [j.to, j.to, 0];
        else [a, b, t] = [j.to, j.from, (e - j.outH - j.workH) / j.backH];
        tx = a.x + 0.5 + (b.x - a.x) * t;
        ty = a.y + 0.5 + (b.y - a.y) * t;
        img.setFlipX(b.x < a.x);
      }
      img.setPosition(tx * T, ty * T).setDepth(10 + ty + 0.4);
    }
  }

  // ---------- input ----------

  setupInput() {
    const cam = this.cameras.main;

    this.input.on('pointerdown', () => {
      this.dragging = false;
    });

    this.input.on('pointermove', (p) => {
      if (p.isDown) {
        if (Phaser.Math.Distance.Between(p.downX, p.downY, p.x, p.y) > DRAG_THRESHOLD) this.dragging = true;
        if (this.dragging) {
          cam.scrollX -= (p.x - p.prevPosition.x) / cam.zoom;
          cam.scrollY -= (p.y - p.prevPosition.y) / cam.zoom;
          this.clampCamera();
        }
      }
      this.updateHover(p);
    });

    this.input.on('pointerup', (p) => {
      if (!this.dragging) this.handleTap(p);
      this.dragging = false;
    });

    this.input.on('wheel', (p, objs, dx, dy) => {
      cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), this.minZoom, 2));
      this.clampCamera();
    });
  }

  // footprint top-left for the building being placed, centred on the pointer's tile
  anchorFor(t) {
    const { w, h } = sizeOf(getDef(this.controller.data, this.selected));
    return { x: t.x - Math.floor((w - 1) / 2), y: t.y - Math.floor((h - 1) / 2), w, h };
  }

  updateHover(p) {
    const t = this.tileAtPointer(p);
    this.ghost.setVisible(false);
    this.ghostArea.setVisible(false);
    if (!t || this.dragging) return this.hover.setVisible(false);
    const { state, data } = this.controller;
    const node = nodeAt(state, t.x, t.y);

    if (this.selected && !node) {
      // ghost preview: the building itself, plus a green/red outline of every tile it would cover
      const a = this.anchorFor(t);
      const ok = canPlace(state, data, this.selected, a.x, a.y).ok;
      this.hover.setVisible(false);
      this.ghostArea
        .clear()
        .fillStyle(ok ? 0x7cfc9a : 0xff6b6b, 0.25)
        .fillRect(a.x * T, a.y * T, a.w * T, a.h * T)
        .lineStyle(3, ok ? 0x7cfc9a : 0xff6b6b, 0.9)
        .strokeRect(a.x * T + 1.5, a.y * T + 1.5, a.w * T - 3, a.h * T - 3)
        .setVisible(true);
      this.ghost
        .setTexture(`bld_${this.selected}`)
        .setOrigin(0.5, 1)
        .setPosition((a.x + a.w / 2) * T, (a.y + a.h) * T)
        .setTint(ok ? 0xffffff : 0xff8080)
        .setVisible(true);
      return;
    }

    this.hover.setPosition(t.x * T, t.y * T).setVisible(true);
    if (node && !this.demolishMode) {
      this.hover.setTint(node.claimedBy ? 0xffffff : 0xffd84a); // yellow = tap to scavenge
    } else if (this.demolishMode) {
      const b = buildingAt(state, t.x, t.y);
      if (b) this.hover.setPosition(b.x * T, b.y * T).setScale(b.w, b.h);
      this.hover.setTint(b ? 0xffb347 : 0xffffff);
      if (b) return;
    } else {
      this.hover.setTint(0xffffff);
    }
    this.hover.setScale(1);
  }

  handleTap(p) {
    const t = this.tileAtPointer(p);
    if (!t) return;
    const { state, data } = this.controller;
    if (!ACTIVE_PHASES.includes(this.controller.phase)) return;
    const node = nodeAt(state, t.x, t.y);

    if (this.demolishMode) {
      const r = this.controller.demolish(t.x, t.y);
      bus.emit('toast', r.ok ? { text: `${r.name} demolished, ${r.refund} metal back.` } : { text: r.reason, warn: true });
    } else if (node) {
      // tapping scavenge nodes always sends a rover, even with a building selected (like clearing in CoC)
      if (!node.claimedBy) {
        const r = this.controller.sendRover(node.id);
        const nd = getNodeDef(data, node.type);
        bus.emit(
          'toast',
          r.ok
            ? { text: `Rover heading to the ${nd.name.toLowerCase()}. Back in about ${Math.ceil(r.trip.hours)} Mars hours (−${r.trip.kWh} kWh).` }
            : { text: r.reason, warn: true }
        );
      }
      bus.emit('inspect-node', node); // after sending, so the card shows the rover as assigned
    } else if (this.selected) {
      const a = this.anchorFor(t);
      const r = this.controller.place(this.selected, a.x, a.y);
      if (!r.ok) bus.emit('toast', { text: r.reason, warn: true });
    } else {
      const b = buildingAt(state, t.x, t.y);
      if (b) bus.emit('inspect', b);
    }
    this.updateHover(p);
  }
}