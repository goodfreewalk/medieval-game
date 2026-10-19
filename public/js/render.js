import { state, getTileOwner } from "./state.js";
import { TERRAIN } from "./terrain.js";
import { PLAYER_COLORS } from "./units.js";

// ---------- Спрайты (эмодзи) ----------

// Ключи — сами константы TERRAIN (значения клеток карты), а не буквы:
// так словарь работает при любом внутреннем представлении местности
const TERRAIN_EMOJI = {
  [TERRAIN.FOREST]: "🌲",
  [TERRAIN.HILL]: "⛰️",
  [TERRAIN.WATER]: "🌊",
  [TERRAIN.MOUNTAIN]: "🏔️",
  [TERRAIN.CASTLE]: "🏰",
  [TERRAIN.VILLAGE]: "🏘️"
};

const UNIT_ICONS = {
  militia: "🪓",
  archer: "🏹",
  swordsman: "⚔️",
  lightCavalry: "🏇",
  heavyCavalry: "🏇️️⚔️",
  horseArcher: "🏇🏹"
};
// Конница рисуется композиционно: лошадь целиком + бейдж оружия/лука
// в правом верхнем квадранте (склеенные эмодзи сжимали лошадь)
const CAVALRY_TYPES = new Set(["lightCavalry", "heavyCavalry", "horseArcher"]);
const CAVALRY_BASE = "🏇";
const UNIT_BADGE = { heavyCavalry: "⚔️", horseArcher: "🏹" };

const EMOJI_FONT =
  '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", serif';

// Разрешение спрайта: с запасом под максимальный зум и hi-dpi.
// Если на самом глубоком зуме захочется чётче — подними эту константу
const SPRITE_RES = 512;

const spriteCache = new Map();

// Эмодзи растеризуется ОДИН раз в офскрин-canvas без трансформаций;
// в мир он идёт как картинка через drawImage — это порядково дешевле,
// чем fillText с цветным глифом каждый кадр
function getSprite(emoji) {
  let sprite = spriteCache.get(emoji);

  if (sprite) {
    return sprite;
  }

  sprite = document.createElement("canvas");
  sprite.width = SPRITE_RES;
  sprite.height = SPRITE_RES;

  const sctx = sprite.getContext("2d");
  sctx.textAlign = "center";
  sctx.textBaseline = "middle";
  sctx.fillStyle = "#ffffff";
  sctx.font = `${SPRITE_RES * 0.82}px ${EMOJI_FONT}`;
  sctx.fillText(emoji, SPRITE_RES / 2, SPRITE_RES / 2 + SPRITE_RES * 0.04);

  spriteCache.set(emoji, sprite);
  return sprite;
}

// ---------- Цвета ----------

const GRASS_A = "#7bb546";
const GRASS_B = "#74ad43";
const FOREST_BG = "#4e8f3a";
const HILL_BG = "#b0a06a";
const WATER_BG = "#3d85c8";
const MOUNTAIN_BG = "#8d8d8d";

// Подложка вне карты — того же цвета, что вода: карта как остров в море
const SEA_BG = WATER_BG;

function terrainBackground(terrain, x, y) {
  if (terrain === TERRAIN.FOREST) return FOREST_BG;
  if (terrain === TERRAIN.HILL) return HILL_BG;
  if (terrain === TERRAIN.WATER) return WATER_BG;
  if (terrain === TERRAIN.MOUNTAIN) return MOUNTAIN_BG;
  return (x + y) % 2 === 0 ? GRASS_A : GRASS_B;
}

// ---------- Плавное движение юнитов ----------

const visualPos = new Map();
let lastMap = null;

function updateVisualPositions() {
  const alive = new Set();

  for (const unit of state.units) {
    alive.add(unit.id);

    let vp = visualPos.get(unit.id);

    if (!vp) {
      vp = { x: unit.x, y: unit.y };
      visualPos.set(unit.id, vp);
    }

    vp.x += (unit.x - vp.x) * 0.22;
    vp.y += (unit.y - vp.y) * 0.22;

    if (Math.abs(unit.x - vp.x) < 0.01) vp.x = unit.x;
    if (Math.abs(unit.y - vp.y) < 0.01) vp.y = unit.y;
  }

  for (const id of Array.from(visualPos.keys())) {
    if (!alive.has(id)) {
      visualPos.delete(id);
    }
  }
}

// Есть ли незавершённое скольжение (нужны ли новые кадры анимации)
function animationsActive() {
  for (const unit of state.units) {
    const vp = visualPos.get(unit.id);

    if (!vp) {
      return true;
    }

    if (vp.x !== unit.x || vp.y !== unit.y) {
      return true;
    }
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

  // Новая партия/резюм — сбрасываем визуальные позиции
  if (lastMap !== state.map) {
    lastMap = state.map;
    visualPos.clear();
  }

  updateVisualPositions();

  const dpr = state.dpr || 1;

  // Экранные координаты: очистка и «море» по бокам
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, state.viewW, state.viewH);
  ctx.fillStyle = SEA_BG;
  ctx.fillRect(0, 0, state.viewW, state.viewH);

  // Мировые координаты: камера
  ctx.translate(state.panX, state.panY);
  ctx.scale(state.zoom, state.zoom);

  const T = state.tileSize;
  const size = state.map.length;

  // ----- Клетки местности -----
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x * T;
      const py = y * T;
      const terrain = state.map[y][x];

      ctx.fillStyle = terrainBackground(terrain, x, y);
      ctx.fillRect(px, py, T, T);

      const emoji = TERRAIN_EMOJI[terrain];

      if (emoji) {
        const s = T * 0.72;
        ctx.drawImage(
          getSprite(emoji),
          px + (T - s) / 2,
          py + (T - s) / 2 + T * 0.02,
          s,
          s
        );
      }
    }
  }

  // ----- Подсветки хода (под юнитами) -----
  for (const key of state.reachableTiles.keys()) {
    const [x, y] = key.split(",").map(Number);
    ctx.fillStyle = "rgba(80, 220, 120, 0.35)";
    ctx.fillRect(x * T, y * T, T, T);
  }

  for (const key of state.attackableTiles.keys()) {
    const [x, y] = key.split(",").map(Number);
    ctx.fillStyle = "rgba(229, 72, 77, 0.30)";
    ctx.fillRect(x * T, y * T, T, T);
    ctx.strokeStyle = "#e5484d";
    ctx.lineWidth = T * 0.05;
    ctx.strokeRect(x * T + 2, y * T + 2, T - 4, T - 4);
  }

  // ----- Здания: рамка и флаг владельца -----
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const terrain = state.map[y][x];

      if (terrain !== TERRAIN.CASTLE && terrain !== TERRAIN.VILLAGE) {
        continue;
      }

      const owner = getTileOwner(x, y);

      if (owner === 0) {
        continue;
      }

      const px = x * T;
      const py = y * T;

      ctx.strokeStyle = PLAYER_COLORS[owner];
      ctx.lineWidth = T * 0.06;
      ctx.strokeRect(
        px + ctx.lineWidth / 2,
        py + ctx.lineWidth / 2,
        T - ctx.lineWidth,
        T - ctx.lineWidth
      );

      // Флаг: древко + сплошное прямоугольное полотнище
      const poleW = Math.max(2, T * 0.05);
      const fx = px + T * 0.74;
      const fy = py + T * 0.08;

      ctx.fillStyle = "#3a2b1a";
      ctx.fillRect(fx, fy, poleW, T * 0.36);

      ctx.fillStyle = PLAYER_COLORS[owner];
      ctx.fillRect(fx + poleW, fy, T * 0.26, T * 0.17);

      ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
      ctx.lineWidth = 1;
      ctx.strokeRect(fx + poleW, fy, T * 0.26, T * 0.17);
    }
  }

  // ----- Выбранная клетка -----
  if (state.selectedTile) {
    const px = state.selectedTile.x * T;
    const py = state.selectedTile.y * T;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.lineWidth = T * 0.05;
    ctx.strokeRect(px + 2, py + 2, T - 4, T - 4);
  }

  // ----- Юниты (с плавным скольжением и спрайт-иконками) -----
  for (const unit of state.units) {
    const vp = visualPos.get(unit.id) || { x: unit.x, y: unit.y };
    const cx = vp.x * T + T / 2;
    const cy = vp.y * T + T / 2;

    const exhausted =
      unit.owner === state.currentPlayer &&
      unit.hasAttacked &&
      unit.movementLeft <= 0;

    ctx.globalAlpha = exhausted ? 0.55 : 1;

    ctx.beginPath();
    ctx.arc(cx, cy, T * 0.30, 0, Math.PI * 2);
    ctx.fillStyle = PLAYER_COLORS[unit.owner];
    ctx.fill();

    if (unit === state.selectedUnit) {
      ctx.lineWidth = T * 0.06;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    } else {
      ctx.lineWidth = Math.max(1, T * 0.03);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.4)";
      ctx.stroke();
    }

    const R = T * 0.30;

    if (CAVALRY_TYPES.has(unit.type)) {
      // Лошадь со всадником — целиком по центру круга
      const bs = T * 0.52;
      ctx.drawImage(getSprite(CAVALRY_BASE), cx - bs / 2, cy - bs / 2, bs, bs);

      // Бейдж (лук / меч) — в правом верхнем квадранте, меньше
      const badge = UNIT_BADGE[unit.type];

      if (badge) {
        const gd = T * 0.30;
        const gx = cx + R * 0.42;
        const gy = cy - R * 0.42;
        ctx.drawImage(getSprite(badge), gx - gd / 2, gy - gd / 2, gd, gd);
      }
    } else {
      const icon = UNIT_ICONS[unit.type];

      if (icon) {
        const s = T * 0.46;
        ctx.drawImage(getSprite(icon), cx - s / 2, cy - s / 2 - T * 0.02, s, s);
      }
    }

    // Здоровье под кругом (обычный текст: цифры дёшевы)
    ctx.font = `bold ${T * 0.17}px sans-serif`;
    ctx.lineWidth = T * 0.05;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
    ctx.strokeText(String(unit.hp), cx, cy + T * 0.42);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(String(unit.hp), cx, cy + T * 0.42);

    ctx.globalAlpha = 1;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ---------- Кадровый цикл с dirty-флагом ----------

let rafId = null;
let needsDraw = true;

function tick() {
  rafId = null;

  const animating = animationsActive();

  if (needsDraw || animating) {
    needsDraw = false;
    drawFrame();
  }

  // Продолжаем крутить цикл только пока есть карта И есть причина
  // рисовать (анимация ещё скользит или поступил новый запрос кадра).
  // В простое цикл остановлен — CPU/GPU не тратятся.
  if (state.map && (needsDraw || animationsActive())) {
    rafId = requestAnimationFrame(tick);
  }
}

export function drawGame() {
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