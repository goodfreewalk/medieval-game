import { MAP_SIZE, TERRAIN, TERRAIN_COLORS } from "./terrain.js";
import { PLAYER_COLORS } from "./units.js";
import { state, getTileOwner } from "./state.js";

function drawTile(x, y, terrain) {
  const ctx = state.ctx;
  const tileSize = state.tileSize;

  ctx.fillStyle = TERRAIN_COLORS[terrain] || "#ff00ff";
  ctx.fillRect(
    x * tileSize,
    y * tileSize,
    tileSize,
    tileSize
  );

  ctx.strokeStyle = "rgba(0, 0, 0, 0.15)";
  ctx.lineWidth = 1;
  ctx.strokeRect(
    x * tileSize,
    y * tileSize,
    tileSize,
    tileSize
  );

  // Показываем владельца деревни или замка
  if (terrain === TERRAIN.VILLAGE || terrain === TERRAIN.CASTLE) {
    const owner = getTileOwner(x, y);

    if (owner !== 0) {
      ctx.strokeStyle = PLAYER_COLORS[owner];
      ctx.lineWidth = 3;
      ctx.strokeRect(
        x * tileSize + 2,
        y * tileSize + 2,
        tileSize - 4,
        tileSize - 4
      );
    }
  }
}

function drawReachableTiles() {
  const ctx = state.ctx;
  const tileSize = state.tileSize;

  for (const tile of state.reachableTiles.values()) {
    ctx.fillStyle = "rgba(0, 255, 0, 0.25)";
    ctx.fillRect(
      tile.x * tileSize,
      tile.y * tileSize,
      tileSize,
      tileSize
    );

    ctx.strokeStyle = "rgba(0, 255, 0, 0.45)";
    ctx.lineWidth = 1;
    ctx.strokeRect(
      tile.x * tileSize,
      tile.y * tileSize,
      tileSize,
      tileSize
    );
  }
}

function drawAttackableTiles() {
  const ctx = state.ctx;
  const tileSize = state.tileSize;

  for (const tile of state.attackableTiles.values()) {
    ctx.fillStyle = "rgba(255, 0, 0, 0.30)";
    ctx.fillRect(
      tile.x * tileSize,
      tile.y * tileSize,
      tileSize,
      tileSize
    );

    ctx.strokeStyle = "rgba(255, 0, 0, 0.55)";
    ctx.lineWidth = 1;
    ctx.strokeRect(
      tile.x * tileSize,
      tile.y * tileSize,
      tileSize,
      tileSize
    );
  }
}

function drawUnits() {
  const ctx = state.ctx;
  const tileSize = state.tileSize;

  for (const unit of state.units) {
    const centerX = unit.x * tileSize + tileSize / 2;
    const centerY = unit.y * tileSize + tileSize / 2;
    const radius = tileSize * 0.30;

    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.fillStyle = PLAYER_COLORS[unit.owner];
    ctx.fill();

    ctx.strokeStyle = "#111111";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.font = "12px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(unit.hp, centerX, centerY);

    // Если юнит уже полностью действовал, рисуем маленькую серую точку
    if (unit.hasAttacked || unit.movementLeft <= 0) {
      ctx.beginPath();
      ctx.arc(
        centerX + tileSize * 0.22,
        centerY - tileSize * 0.22,
        4,
        0,
        Math.PI * 2
      );
      ctx.fillStyle = "#999999";
      ctx.fill();
      ctx.strokeStyle = "#111111";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

function drawSelectedUnit() {
  if (!state.selectedUnit) {
    return;
  }

  const ctx = state.ctx;
  const tileSize = state.tileSize;

  const centerX = state.selectedUnit.x * tileSize + tileSize / 2;
  const centerY = state.selectedUnit.y * tileSize + tileSize / 2;
  const radius = tileSize * 0.36;

  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.strokeStyle = "#00e5ff";
  ctx.lineWidth = 3;
  ctx.stroke();
}

function drawSelectedTile() {
  if (!state.selectedTile) {
    return;
  }

  const ctx = state.ctx;
  const tileSize = state.tileSize;

  ctx.strokeStyle = "#ffff00";
  ctx.lineWidth = 3;
  ctx.strokeRect(
    state.selectedTile.x * tileSize + 2,
    state.selectedTile.y * tileSize + 2,
    tileSize - 4,
    tileSize - 4
  );
}

export function drawGame() {
  const ctx = state.ctx;
  const canvas = state.canvas;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      drawTile(x, y, state.map[y][x]);
    }
  }

  drawReachableTiles();
  drawAttackableTiles();
  drawUnits();
  drawSelectedUnit();
  drawSelectedTile();
}