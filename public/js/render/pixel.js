// Пиксельный рендер графики v2: спрайты из manifest.json, integer-scale,
// бесшовные целочисленные клетки, эллипс-тени, горизонтальный flip,
// walk/attack — только клиентские таймеры. Общие модули не изменяются.

import { state, getTileOwner } from "../state.js";
import { TERRAIN } from "../terrain.js";
import { getPlayerColor } from "../units.js";
import {
  loadSprites,
  spritesReady,
  pick,
  terrainRaster,
  propRaster,
  unitRaster,
  bannerRaster
} from "./sprites.js";

const TERRAIN_KEY = {
  [TERRAIN.FOREST]: "forest",
  [TERRAIN.HILL]: "hills",
  [TERRAIN.WATER]: "water",
  [TERRAIN.MOUNTAIN]: "mountain"
};

// Типы юнитов игры → ключи манифеста (notes/art-style.md)
const UNIT_KEY = {
  militia: "axe",
  archer: "archer",
  swordsman: "knight",
  lightCavalry: "spear",
  heavyCavalry: "heavy",
  horseArcher: "marcher"
};

// Фолбэк-цвета до загрузки спрайтов (как в legacy)
const GRASS_A = "#7bb546";
const GRASS_B = "#74ad43";
const FOREST_BG = "#4e8f3a";
const HILL_BG = "#b0a06a";
const WATER_BG = "#3d85c8";
const MOUNTAIN_BG = "#8d8d8d";
const SEA_BG = WATER_BG;

const WALK_MS = 180;
const ATTACK_MS = 400;

// ---------- Клиентское состояние анимаций ----------

const visualPos = new Map();
const facing = new Map();
const attackUntil = new Map();
let lastMap = null;

export function notifyAttack(attackerId) {
  attackUntil.set(attackerId, performance.now() + ATTACK_MS);
  drawGame();
}

function fallbackBackground(terrain, x, y) {
  if (terrain === TERRAIN.FOREST) return FOREST_BG;
  if (terrain === TERRAIN.HILL) return HILL_BG;
  if (terrain === TERRAIN.WATER) return WATER_BG;
  if (terrain === TERRAIN.MOUNTAIN) return MOUNTAIN_BG;
  return (x + y) % 2 === 0 ? GRASS_A : GRASS_B;
}

function updateVisualPositions() {
  const alive = new Set();

  for (const unit of state.units) {
    alive.add(unit.id);

    let vp = visualPos.get(unit.id);
    if (!vp) {
      vp = { x: unit.x, y: unit.y };
      visualPos.set(unit.id, vp);
    }

    const dx = unit.x - vp.x;
    if (Math.abs(dx) > 0.05) {
      facing.set(unit.id, dx < 0 ? "left" : "right");
    }

    vp.x += dx * 0.22;
    vp.y += (unit.y - vp.y) * 0.22;

    if (Math.abs(unit.x - vp.x) < 0.01) vp.x = unit.x;
    if (Math.abs(unit.y - vp.y) < 0.01) vp.y = unit.y;
  }

  for (const id of Array.from(visualPos.keys())) {
    if (!alive.has(id)) {
      visualPos.delete(id);
      facing.delete(id);
      attackUntil.delete(id);
    }
  }
}

function animationsActive() {
  const now = performance.now();
  for (const until of attackUntil.values()) {
    if (until > now) return true;
  }
  for (const unit of state.units) {
    const vp = visualPos.get(unit.id);
    if (!vp || vp.x !== unit.x || vp.y !== unit.y) return true;
  }
  return false;
}

// ---------- Отрисовка кадра ----------

function drawFrame() {
  const ctx = state.ctx;
  const canvas = state.canvas;

  if (!ctx || !canvas || !state.map) {
    return;
  }

  if (lastMap !== state.map) {
    lastMap = state.map;
    visualPos.clear();
    facing.clear();
    attackUntil.clear();
  }

  updateVisualPositions();

  const dpr = state.dpr || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, state.viewW, state.viewH);
  ctx.fillStyle = SEA_BG;
  ctx.fillRect(0, 0, state.viewW, state.viewH);

  const T = state.tileSize;
  const z = state.zoom;
  const panX = state.panX;
  const panY = state.panY;
  const size = state.map.length;
  const ready = spritesReady();

  // Целочисленные экранные границы клеток: соседние тайлы делят
  // одну и ту же границу — бесшовно, без щелей при дробном зуме
  const sxOf = x => Math.round(x * T * z + panX);
  const syOf = y => Math.round(y * T * z + panY);

  const left = -panX / z;
  const top = -panY / z;
  const right = (state.viewW - panX) / z;
  const bottom = (state.viewH - panY) / z;
  const minX = Math.max(0, Math.floor(left / T) - 1);
  const minY = Math.max(0, Math.floor(top / T) - 1);
  const maxX = Math.min(size - 1, Math.ceil(right / T) + 1);
  const maxY = Math.min(size - 1, Math.ceil(bottom / T) + 1);

  // ----- Местность: full-bleed тайлы -----
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const sx = sxOf(x);
      const sy = syOf(y);
      const sw = sxOf(x + 1) - sx;
      const sh = syOf(y + 1) - sy;
      const terrain = state.map[y][x];
      const r = ready ? terrainRaster(TERRAIN_KEY[terrain] || "grass") : null;

      if (r) {
        ctx.drawImage(pick(r, sw), sx, sy, sw, sh);
      } else {
        ctx.fillStyle = fallbackBackground(terrain, x, y);
        ctx.fillRect(sx, sy, sw, sh);
      }
    }
  }

  // ----- Здания: ровно 1 клетка + рамка и баннер владельца -----
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const terrain = state.map[y][x];
      if (terrain !== TERRAIN.CASTLE && terrain !== TERRAIN.VILLAGE) {
        continue;
      }

      const sx = sxOf(x);
      const sy = syOf(y);
      const sw = sxOf(x + 1) - sx;
      const sh = syOf(y + 1) - sy;

      const r = ready
        ? propRaster(terrain === TERRAIN.CASTLE ? "castle" : "village")
        : null;
      if (r) {
        ctx.drawImage(pick(r, sw), sx, sy, sw, sh);
      }

      const owner = getTileOwner(x, y);
      if (owner === 0) continue;

      const color = getPlayerColor(owner, state.playerColors);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, sw * 0.06);
      ctx.strokeRect(
        sx + ctx.lineWidth / 2,
        sy + ctx.lineWidth / 2,
        sw - ctx.lineWidth,
        sh - ctx.lineWidth
      );

      const b = ready ? bannerRaster(color) : null;
      if (b) {
        const bs = Math.round(sw * 0.4);
        ctx.drawImage(b, sx + sw - bs - Math.round(sw * 0.04), sy + Math.round(sh * 0.04), bs, bs);
      }
    }
  }

  // ----- Подсветки хода -----
  for (const key of state.reachableTiles.keys()) {
    const [x, y] = key.split(",").map(Number);
    ctx.fillStyle = "rgba(80, 220, 120, 0.35)";
    ctx.fillRect(sxOf(x), syOf(y), sxOf(x + 1) - sxOf(x), syOf(y + 1) - syOf(y));
  }

  for (const key of state.attackableTiles.keys()) {
    const [x, y] = key.split(",").map(Number);
    const sx = sxOf(x);
    const sy = syOf(y);
    const sw = sxOf(x + 1) - sx;
    const sh = syOf(y + 1) - sy;
    ctx.fillStyle = "rgba(229, 72, 77, 0.30)";
    ctx.fillRect(sx, sy, sw, sh);
    ctx.strokeStyle = "#e5484d";
    ctx.lineWidth = Math.max(1, sw * 0.05);
    ctx.strokeRect(sx + 2, sy + 2, sw - 4, sh - 4);
  }

  if (state.selectedTile) {
    const sx = sxOf(state.selectedTile.x);
    const sy = syOf(state.selectedTile.y);
    const sw = sxOf(state.selectedTile.x + 1) - sx;
    const sh = syOf(state.selectedTile.y + 1) - sy;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.lineWidth = Math.max(1, sw * 0.05);
    ctx.strokeRect(sx + 2, sy + 2, sw - 4, sh - 4);
  }

  // ----- Юниты: 1 клетка, эллипс-тень, flip, walk/attack -----
  const now = performance.now();
  const cell = Math.round(T * z);

  for (const unit of state.units) {
    const vp = visualPos.get(unit.id) || { x: unit.x, y: unit.y };
    if (vp.x < minX || vp.x > maxX || vp.y < minY || vp.y > maxY) continue;

    const cx = (vp.x * T + T / 2) * z + panX;
    const cy = (vp.y * T + T / 2) * z + panY;

    const exhausted =
      unit.owner === state.currentPlayer &&
      unit.hasAttacked &&
      unit.movementLeft <= 0;
    ctx.globalAlpha = exhausted ? 0.55 : 1;

    // Тень — эллипс под спрайтом
    ctx.beginPath();
    ctx.ellipse(cx, cy + cell * 0.32, cell * 0.30, cell * 0.10, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
    ctx.fill();

    const moving = vp.x !== unit.x || vp.y !== unit.y;
    const attacking = (attackUntil.get(unit.id) || 0) > now;
    const frame = attacking
      ? "attack"
      : moving && Math.floor(now / WALK_MS) % 2 === 1
        ? "walkB"
        : "walkA";

    const r = ready ? unitRaster(UNIT_KEY[unit.type], frame) : null;
    if (r) {
      const c = pick(r, cell);
      ctx.save();
      ctx.translate(cx, cy);
      if (facing.get(unit.id) === "left") ctx.scale(-1, 1);
      ctx.drawImage(c, -cell / 2, -cell / 2, cell, cell);
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 0.30, 0, Math.PI * 2);
      ctx.fillStyle = getPlayerColor(unit.owner, state.playerColors);
      ctx.fill();
    }

    if (unit === state.selectedUnit) {
      ctx.lineWidth = Math.max(1, cell * 0.06);
      ctx.strokeStyle = "#ffffff";
      ctx.strokeRect(cx - cell / 2 + 1, cy - cell / 2 + 1, cell - 2, cell - 2);
    }

    // B21: прогресс-бар здоровья
    const bw = cell * 0.62;
    const bh = Math.max(2, cell * 0.09);
    const bx = cx - bw / 2;
    const by = cy + cell * 0.34;
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
    const frac = Math.max(0, Math.min(1, unit.hp / 100));
    ctx.fillStyle = frac > 0.5 ? "#3dbb4a" : frac > 0.25 ? "#e6c229" : "#e5484d";
    ctx.fillRect(bx, by, bw * frac, bh);

    ctx.globalAlpha = 1;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ---------- Кадровый цикл с dirty-флагом ----------

let rafId = null;
let needsDraw = true;
let spritesRequested = false;

function tick() {
  rafId = null;

  if (needsDraw || animationsActive()) {
    needsDraw = false;
    drawFrame();
  }

  if (state.map && (needsDraw || animationsActive())) {
    rafId = requestAnimationFrame(tick);
  }
}

export function drawGame() {
  if (!spritesRequested) {
    spritesRequested = true;
    loadSprites().then(ok => {
      if (ok) drawGame();
    });
  }

  needsDraw = true;

  if (typeof requestAnimationFrame === "undefined") {
    needsDraw = false;
    drawFrame();
    return;
  }

  if (rafId === null) {
    rafId = requestAnimationFrame(tick);
  }
}
