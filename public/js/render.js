import { state, getTileOwner } from "./state.js";
import { TERRAIN } from "./terrain.js";
import { PLAYER_COLORS } from "./units.js";

// Цвета местности
const TERRAIN_COLORS = {
  [TERRAIN.GRASS]: "#7bb546",
  [TERRAIN.FOREST]: "#4e8f3a",
  [TERRAIN.HILL]: "#b0a06a",
  [TERRAIN.WATER]: "#3d85c8",
  [TERRAIN.MOUNTAIN]: "#8d8d8d",
  [TERRAIN.VILLAGE]: "#d9a441",
  [TERRAIN.CASTLE]: "#b06fd8"
};

// Иконки местности и зданий
const TERRAIN_ICONS = {
  [TERRAIN.FOREST]: "🌲",
  [TERRAIN.HILL]: "⛰️",
  [TERRAIN.WATER]: "🌊",
  [TERRAIN.MOUNTAIN]: "🏔️",
  [TERRAIN.VILLAGE]: "🏘️",
  [TERRAIN.CASTLE]: "🏰"
};

// Иконки юнитов: основная и дополнительная поверх
const UNIT_ICONS = {
  militia: { main: "🪓" },
  archer: { main: "🏹" },
  swordsman: { main: "⚔️" },
  lightCavalry: { main: "🏇" },
  heavyCavalry: { main: "🏇", overlay: "⚔️" },
  horseArcher: { main: "🏇", overlay: "🏹" }
};

// ---------- Анимация ----------

const renderPos = new Map();
const prevUnits = new Map();
const effects = [];

let loopStarted = false;
let lastTime = 0;

function startLoop() {
  loopStarted = true;
  lastTime = performance.now();
  requestAnimationFrame(frame);
}

function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  update(dt);
  draw();

  requestAnimationFrame(frame);
}

function update(dt) {
  // Плавное скольжение юнитов
  for (const unit of state.units) {
    let rp = renderPos.get(unit.id);

    if (!rp) {
      renderPos.set(unit.id, { x: unit.x, y: unit.y });
      effects.push({ type: "pop", x: unit.x, y: unit.y, t: 0, dur: 0.35 });
      continue;
    }

    const speed = 10;
    rp.x += (unit.x - rp.x) * Math.min(1, dt * speed);
    rp.y += (unit.y - rp.y) * Math.min(1, dt * speed);

    if (Math.abs(unit.x - rp.x) < 0.01) rp.x = unit.x;
    if (Math.abs(unit.y - rp.y) < 0.01) rp.y = unit.y;
  }

  // Замечаем урон и смерть
  const alive = new Set();

  for (const unit of state.units) {
    alive.add(unit.id);

    const prev = prevUnits.get(unit.id);

    if (prev && unit.hp < prev.hp) {
      effects.push({ type: "hit", x: unit.x, y: unit.y, t: 0, dur: 0.4 });
    }

    prevUnits.set(unit.id, { hp: unit.hp, x: unit.x, y: unit.y });
  }

  for (const [id, prev] of prevUnits) {
    if (!alive.has(id)) {
      effects.push({ type: "death", x: prev.x, y: prev.y, t: 0, dur: 0.5 });
      prevUnits.delete(id);
      renderPos.delete(id);
    }
  }

  // Продвигаем эффекты
  for (let i = effects.length - 1; i >= 0; i--) {
    effects[i].t += dt;

    if (effects[i].t >= effects[i].dur) {
      effects.splice(i, 1);
    }
  }
}

// ---------- Рисование ----------

function drawEmoji(ctx, emoji, x, y, size) {
  ctx.save();
  ctx.font = `${size}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, x, y);
  ctx.restore();
}

// Число здоровья под юнитом
function drawHpNumber(ctx, hp, cx, cy, ts) {
  ctx.save();
  ctx.font = `bold ${Math.round(ts * 0.22)}px Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.8)";
  ctx.strokeText(hp, cx, cy + ts * 0.42);

  ctx.fillStyle = "#ffffff";
  ctx.fillText(hp, cx, cy + ts * 0.42);
  ctx.restore();
}

function draw() {
  const ctx = state.ctx;

  // ФИКС: не рисуем, пока игра не инициализирована
  // (иначе смена языка в меню убивала render-цикл навсегда)
  if (!ctx || !state.map || !state.canvas) {
    return;
  }

  const ts = state.tileSize;

  ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);

  // --- Клетки местности ---
  for (let y = 0; y < state.map.length; y++) {
    for (let x = 0; x < state.map[y].length; x++) {
      const terrain = state.map[y][x];
      const px = x * ts;
      const py = y * ts;

      // Базовый фон: деревни и замки на зелёном
      if (terrain === TERRAIN.VILLAGE || terrain === TERRAIN.CASTLE) {
        ctx.fillStyle = TERRAIN_COLORS[TERRAIN.GRASS];
      } else {
        ctx.fillStyle = TERRAIN_COLORS[terrain];
      }

      ctx.fillRect(px, py, ts, ts);

      if (terrain === TERRAIN.GRASS && (x + y) % 2 === 0) {
        ctx.fillStyle = "rgba(255,255,255,0.05)";
        ctx.fillRect(px, py, ts, ts);
      }

      const owner = getTileOwner(x, y);

      // Иконка местности или здания (здания крупнее)
      if (TERRAIN_ICONS[terrain]) {
        const size =
          terrain === TERRAIN.CASTLE || terrain === TERRAIN.VILLAGE
            ? ts * 0.7
            : ts * 0.62;

        drawEmoji(ctx, TERRAIN_ICONS[terrain], px + ts / 2, py + ts / 2, size);
      }

      // Рамка владельца по краю клетки
      if (owner !== 0) {
        ctx.strokeStyle = PLAYER_COLORS[owner];
        ctx.lineWidth = 3;
        ctx.strokeRect(px + 1.5, py + 1.5, ts - 3, ts - 3);
      }

      // Значок владельца на зданиях
      if (
        owner !== 0 &&
        (terrain === TERRAIN.CASTLE || terrain === TERRAIN.VILLAGE)
      ) {
        ctx.beginPath();
        ctx.arc(px + ts * 0.82, py + ts * 0.18, ts * 0.12, 0, Math.PI * 2);
        ctx.fillStyle = PLAYER_COLORS[owner];
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
      }

      ctx.strokeStyle = "rgba(0,0,0,0.08)";
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, ts - 1, ts - 1);
    }
  }

  // --- Подсветка движения ---
  for (const tile of state.reachableTiles.values()) {
    ctx.fillStyle = "rgba(0, 255, 120, 0.28)";
    ctx.fillRect(tile.x * ts, tile.y * ts, ts, ts);
  }

  // --- Подсветка атаки ---
  for (const tile of state.attackableTiles.values()) {
    ctx.fillStyle = "rgba(255, 60, 60, 0.35)";
    ctx.fillRect(tile.x * ts, tile.y * ts, ts, ts);
  }

  // --- Выбранная клетка ---
  if (state.selectedTile) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.strokeRect(
      state.selectedTile.x * ts + 1.5,
      state.selectedTile.y * ts + 1.5,
      ts - 3,
      ts - 3
    );
  }

  // --- Юниты ---
  for (const unit of state.units) {
    const rp = renderPos.get(unit.id) || { x: unit.x, y: unit.y };

    const cx = rp.x * ts + ts / 2;
    const cy = rp.y * ts + ts / 2;

    const acted =
      unit.owner === state.currentPlayer &&
      (unit.hasAttacked || unit.movementLeft <= 0);

    ctx.save();

    if (acted) {
      ctx.globalAlpha = 0.55;
    }

    // Просто цветной круг без окантовки
    ctx.beginPath();
    ctx.arc(cx, cy, ts * 0.34, 0, Math.PI * 2);
    ctx.fillStyle = PLAYER_COLORS[unit.owner];
    ctx.fill();

    // Основная иконка
    const icons = UNIT_ICONS[unit.type];
    drawEmoji(ctx, icons.main, cx, cy, ts * 0.4);

    // Дополнительная иконка поверх (лук или меч у конницы)
    if (icons.overlay) {
      drawEmoji(ctx, icons.overlay, cx + ts * 0.22, cy - ts * 0.24, ts * 0.26);
    }

    // Число здоровья внизу
    drawHpNumber(ctx, unit.hp, cx, cy, ts);

    ctx.restore();
  }

  // --- Эффекты ---
  for (const effect of effects) {
    const progress = effect.t / effect.dur;
    const cx = effect.x * ts + ts / 2;
    const cy = effect.y * ts + ts / 2;

    if (effect.type === "hit") {
      ctx.save();
      ctx.globalAlpha = 1 - progress;
      ctx.strokeStyle = "#ff4d4d";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(cx, cy, ts * (0.2 + progress * 0.4), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (effect.type === "death") {
      ctx.save();
      ctx.globalAlpha = 1 - progress;
      drawEmoji(ctx, "💥", cx, cy, ts * (0.4 + progress * 0.5));
      ctx.restore();
    }

    if (effect.type === "pop") {
      ctx.save();
      ctx.globalAlpha = 1 - progress;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, ts * (0.1 + progress * 0.45), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

}

// Точка входа: запускает цикл отрисовки
// ФИКС: запускаем цикл только когда карта существует
export function drawGame() {
  if (!loopStarted && state.map) {
    startLoop();
  }
}
