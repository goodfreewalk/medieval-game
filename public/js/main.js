import {
  state,
  initGame,
  getPlayerGold,
  getIncome,
  getSupplyCapacity,
  getSupplyUsed,
  getTileOwner
} from "./state.js";
import {
  getLanguage,
  setLanguage,
  t,
  terrainName,
  unitName
} from "./i18n.js";
import {
  getUnitAtTile,
  UNIT_TYPES
} from "./units.js";
import { TERRAIN, TERRAIN_DEFENSE, TERRAIN_COST } from "./terrain.js";
import { drawGame } from "./render.js";
import { showScreen } from "./screens.js";
import { initLobby, getMyPlayerId } from "./lobby.js";
import { onNetworkMessage, sendMessage } from "./network.js";
import {
  updateSelectionHighlights,
  canAttackUnit,
  applyMove,
  applyAttack,
  applyRecruit,
  applyEndTurn,
  getTileFromClick
} from "./logic.js";

// --- Элементы DOM ---

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const info = document.getElementById("info");
const turnInfo = document.getElementById("turnInfo");
const timerElement = document.getElementById("timer");
const endTurnButton = document.getElementById("endTurn");
const resourcesElement = document.getElementById("resources");
const recruitPanel = document.getElementById("recruitPanel");
const langSelect = document.getElementById("lang");
const gameOverOverlay = document.getElementById("gameOverOverlay");
const gameOverText = document.getElementById("gameOverText");
const gameOverReason = document.getElementById("gameOverReason");
const playAgainButton = document.getElementById("playAgainBtn");

// --- Таймер хода ---

const TURN_TIME = 60;
let timerInterval = null;
let timeLeft = TURN_TIME;

// --- Вспомогательные функции ---

function isMyTurn() {
  return state.currentPlayer === getMyPlayerId();
}

function sendAction(action) {
  sendMessage({ type: "gameAction", action });
}

// --- Обновление интерфейса ---

// ФИКС: показываем понятный текст, ключи turn/yourTurn добавлены в i18n
function updateTurnInfo() {
  turnInfo.textContent = isMyTurn()
    ? t("yourTurn")
    : `${t("turn")}: ${state.currentPlayer}`;

  endTurnButton.disabled = !isMyTurn() || state.gameOver;
}

function updateTimerDisplay() {
  timerElement.textContent = timeLeft;
  timerElement.classList.toggle("warning", timeLeft <= 10);
}

function stopTurnTimer() {
  if (timerInterval !== null) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function startTurnTimer() {
  stopTurnTimer();

  timeLeft = TURN_TIME;
  updateTimerDisplay();

  timerInterval = setInterval(() => {
    timeLeft -= 1;
    updateTimerDisplay();

    if (timeLeft <= 0) {
      stopTurnTimer();
      autoEndTurn();
    }
  }, 1000);
}

function autoEndTurn() {
  if (state.gameOver) {
    return;
  }

  if (!isMyTurn()) {
    return;
  }

  const action = { kind: "endTurn" };

  if (runAction(action)) {
    sendAction(action);
  }
}

function updateResources() {
  const player = getMyPlayerId();

  resourcesElement.textContent =
    `${t("gold")}: ${getPlayerGold(player)} | ` +
    `${t("income")}: +${getIncome(player)} | ` +
    `${t("supply")}: ${getSupplyUsed(player)}/${getSupplyCapacity(player)}`;
}

function updateInfo() {
  if (state.selectedUnit) {
    const unit = state.selectedUnit;
    const type = UNIT_TYPES[unit.type];

    let text =
      `${unitName(unit.type)} | ` +
      `${t("player")}: ${unit.owner} | ` +
      `❤️ ${unit.hp}`;

    text += ` | ⚔️ ${type.attack} | 🛡️ ${type.defense} | 👣 ${type.movement}`;

    if (unit.owner === state.currentPlayer) {
      if (unit.hasAttacked) {
        text += ` | ${t("acted")}`;
      } else if (unit.movementLeft < type.movement) {
        text += ` | ${t("moved")}`;
      } else {
        text += ` | ${t("ready")}`;
      }
    }

    info.textContent = text;
    return;
  }

  if (state.selectedTile) {
    const terrain = state.map[state.selectedTile.y][state.selectedTile.x];
    const terrainDef = TERRAIN_DEFENSE[terrain] || 0;
    const terrainCost = TERRAIN_COST[terrain];
    const isPassable = terrainCost !== Infinity;

    let text = terrainName(terrain);

    if (!isPassable) {
      text += ` | 🚫`;
    } else {
      text += ` | 👣 ${terrainCost}`;
    }

    if (terrainDef > 0) {
      text += ` | 🛡️ +${terrainDef}`;
    }

    if (terrain === TERRAIN.VILLAGE || terrain === TERRAIN.CASTLE) {
      const owner = getTileOwner(state.selectedTile.x, state.selectedTile.y);
      const isCastle = terrain === TERRAIN.CASTLE;

      const gold = isCastle ? 6 : 2;
      const supply = isCastle ? 3 : 1;

      text += ` | 💰 +${gold} | 📦 +${supply}`;

      if (owner !== 0) {
        text += ` | 🚩 ${owner}`;
      }
    }

    info.textContent = text;
    return;
  }

  info.textContent = t("infoDefault");
}

function updateRecruitPanel() {
  recruitPanel.innerHTML = "";

  if (!state.selectedTile || state.gameOver) {
    return;
  }

  const tile = state.selectedTile;
  const terrain = state.map[tile.y][tile.x];

  if (terrain !== TERRAIN.CASTLE && terrain !== TERRAIN.VILLAGE) {
    return;
  }

  const owner = getTileOwner(tile.x, tile.y);

  if (owner !== getMyPlayerId()) {
    return;
  }

  if (!isMyTurn()) {
    return;
  }

  if (getUnitAtTile(state.units, tile.x, tile.y)) {
    return;
  }

  const icons = {
    militia: "🪓",
    archer: "🏹",
    swordsman: "⚔️",
    lightCavalry: "🏇",
    heavyCavalry: "🏇⚔️",
    horseArcher: "🏇🏹"
  };

  const types = terrain === TERRAIN.VILLAGE
    ? ["militia"]
    : Object.keys(UNIT_TYPES);

  for (const type of types) {
    const stats = UNIT_TYPES[type];

    const row = document.createElement("div");
    row.className = "recruitRow";

    const button = document.createElement("button");
    button.className = "recruitButton";
    button.textContent = `${icons[type]} ${unitName(type)} 💰 ${stats.cost}`;

    const supplyFull =
      getSupplyUsed(getMyPlayerId()) >= getSupplyCapacity(getMyPlayerId());
    const noGold = getPlayerGold(getMyPlayerId()) < stats.cost;

    if (noGold || supplyFull) {
      button.disabled = true;
    }

    button.addEventListener("click", () => {
      const action = {
        kind: "recruit",
        type,
        x: tile.x,
        y: tile.y
      };

      if (runAction(action)) {
        sendAction(action);
      }
    });

    const statsText = document.createElement("span");
    statsText.className = "recruitStats";
    statsText.textContent =
      `| ⚔️ ${stats.attack} | 🛡️ ${stats.defense} | 👣 ${stats.movement}`;

    row.appendChild(button);
    row.appendChild(statsText);
    recruitPanel.appendChild(row);
  }
}

function refreshGame() {
  updateTurnInfo();
  updateResources();
  updateRecruitPanel();
  updateInfo();
  drawGame();
}

function applyLanguage() {
  langSelect.value = getLanguage();

  endTurnButton.textContent = t("endTurn");
  playAgainButton.textContent = t("playAgain");

  refreshGame();

  if (state.gameOver) {
    showGameOver();
  }
}

// ФИКС: заголовок оверлея заполняем, reason позволяет показать
// «Соперник вышел» / «Соединение потеряно» вместо victory/defeat
function showGameOver(reason) {
  stopTurnTimer();
  gameOverOverlay.classList.remove("hidden");
  gameOverText.textContent = t("gameOver");

  if (reason) {
    gameOverReason.textContent = reason;
  } else if (state.winner === null) {
    gameOverReason.textContent = t("draw");
  } else if (state.winner === getMyPlayerId()) {
    gameOverReason.textContent = t("victory");
  } else {
    gameOverReason.textContent = t("defeat");
  }
}

// --- Обработка выхода соперника ---

// ФИКС: была захардкожена русская строка; не срабатывала повторно,
// если игра уже окончена
function handleOpponentLeft() {
  if (state.gameOver) {
    return;
  }

  state.gameOver = true;
  state.winner = getMyPlayerId();
  showGameOver(t("opponentLeft"));
}

// ФИКС: обрабатываем потерю соединения отдельно от «соперник вышел» —
// раньше любой разрыв сокета показывал оверлей победы даже в меню
function handleConnectionLost() {
  stopTurnTimer();

  if (state.gameOver) {
    return;
  }

  // Игра ещё не началась — показываем статус на текущем экране
  if (!state.map) {
    const menuVisible = !document
      .getElementById("menuScreen")
      .classList.contains("hidden");

    if (menuVisible) {
      document.getElementById("menuStatus").textContent = t("connectionLost");
    } else {
      document.getElementById("lobbyStatus").textContent = t("connectionLost");
    }

    return;
  }

  showGameOver(t("connectionLost"));
}

// --- Выполнение действий ---

function runAction(action) {
  if (action.kind === "move") {
    const result = applyMove(action.unitId, action.x, action.y);

    if (result.success) {
      updateSelectionHighlights();
      refreshGame();
    }

    return result.success;
  }

  if (action.kind === "attack") {
    const result = applyAttack(action.attackerId, action.targetId);

    if (result.success) {
      // Если атакующий погиб от контратаки — снимаем выделение
      const attackerAlive = state.units.some(
        unit => unit.id === action.attackerId
      );

      if (
        !attackerAlive &&
        state.selectedUnit &&
        state.selectedUnit.id === action.attackerId
      ) {
        state.selectedUnit = null;
        state.selectedTile = null;
      }

      updateSelectionHighlights();
      refreshGame();

      if (state.gameOver) {
        showGameOver();
      }
    }

    return result.success;
  }

  if (action.kind === "recruit") {
    const result = applyRecruit(action.type, action.x, action.y);

    if (result.success) {
      refreshGame();

      if (state.gameOver) {
        showGameOver();
      }
    }

    return result.success;
  }

  if (action.kind === "endTurn") {
    applyEndTurn();

    updateSelectionHighlights();
    refreshGame();

    if (state.gameOver) {
      showGameOver();
      return true;
    }

    // ФИКС: таймер тикает только во время СВОЕГО хода —
    // раньше после завершения хода у игрока тикал таймер чужого хода
    if (isMyTurn()) {
      startTurnTimer();
    } else {
      stopTurnTimer();
      timerElement.textContent = "—";
    }

    return true;
  }

  return false;
}

// --- Камера ---

const gameContainer = document.getElementById("gameContainer");

let fitZoom = 1;
let minZoom = 0.5;
let maxZoom = 3;

function applyCanvasTransform() {
  canvas.style.transform =
    `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
}

function clampPan() {
  const rect = gameContainer.getBoundingClientRect();
  const scaledW = canvas.width * state.zoom;
  const scaledH = canvas.height * state.zoom;

  const minX = Math.min(0, rect.width - scaledW);
  const maxX = Math.max(0, rect.width - scaledW);
  const minY = Math.min(0, rect.height - scaledH);
  const maxY = Math.max(0, rect.height - scaledH);

  state.panX = Math.max(minX, Math.min(maxX, state.panX));
  state.panY = Math.max(minY, Math.min(maxY, state.panY));
}

function initCamera() {
  const rect = gameContainer.getBoundingClientRect();

  if (rect.width === 0 || rect.height === 0) {
    return;
  }

  fitZoom = Math.min(
    rect.width / canvas.width,
    rect.height / canvas.height
  );
  minZoom = fitZoom;
  maxZoom = fitZoom * 2;

  state.zoom = fitZoom;
  state.panX = (rect.width - canvas.width * state.zoom) / 2;
  state.panY = (rect.height - canvas.height * state.zoom) / 2;

  clampPan();
  applyCanvasTransform();
}

window.addEventListener("resize", () => {
  initCamera();
});

// --- Жесты и мышь ---

let isDragging = false;
let dragMoved = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartPanX = 0;
let dragStartPanY = 0;
let pinchStartDist = 0;
let pinchStartZoom = 1;

function getTouchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

function zoomAt(localX, localY, newZoom) {
  const worldX = (localX - state.panX) / state.zoom;
  const worldY = (localY - state.panY) / state.zoom;

  state.zoom = Math.max(minZoom, Math.min(maxZoom, newZoom));

  state.panX = localX - worldX * state.zoom;
  state.panY = localY - worldY * state.zoom;

  clampPan();
  applyCanvasTransform();
}

gameContainer.addEventListener("touchstart", (e) => {
  if (e.touches.length === 1) {
    isDragging = true;
    dragMoved = false;
    dragStartX = e.touches[0].clientX;
    dragStartY = e.touches[0].clientY;
    dragStartPanX = state.panX;
    dragStartPanY = state.panY;
  } else if (e.touches.length === 2) {
    isDragging = false;
    pinchStartDist = getTouchDistance(e.touches);
    pinchStartZoom = state.zoom;
  }
}, { passive: true });

gameContainer.addEventListener("touchmove", (e) => {
  if (e.touches.length === 1 && isDragging) {
    const dx = e.touches[0].clientX - dragStartX;
    const dy = e.touches[0].clientY - dragStartY;

    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      dragMoved = true;
    }

    state.panX = dragStartPanX + dx;
    state.panY = dragStartPanY + dy;

    clampPan();
    applyCanvasTransform();
    e.preventDefault();
  } else if (e.touches.length === 2) {
    const dist = getTouchDistance(e.touches);
    const rect = gameContainer.getBoundingClientRect();
    const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
    const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;

    zoomAt(cx, cy, pinchStartZoom * (dist / pinchStartDist));
    e.preventDefault();
  }
}, { passive: false });

gameContainer.addEventListener("touchend", (e) => {
  if (e.touches.length === 0) {
    isDragging = false;
  } else if (e.touches.length === 1) {
    isDragging = true;
    dragStartX = e.touches[0].clientX;
    dragStartY = e.touches[0].clientY;
    dragStartPanX = state.panX;
    dragStartPanY = state.panY;
  }
});

gameContainer.addEventListener("mousedown", (e) => {
  if (e.button !== 0) {
    return;
  }

  isDragging = true;
  dragMoved = false;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragStartPanX = state.panX;
  dragStartPanY = state.panY;
});

window.addEventListener("mousemove", (e) => {
  if (!isDragging) {
    return;
  }

  const dx = e.clientX - dragStartX;
  const dy = e.clientY - dragStartY;

  if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
    dragMoved = true;
  }

  state.panX = dragStartPanX + dx;
  state.panY = dragStartPanY + dy;

  clampPan();
  applyCanvasTransform();
});

window.addEventListener("mouseup", () => {
  isDragging = false;
});

gameContainer.addEventListener("wheel", (e) => {
  e.preventDefault();

  const rect = gameContainer.getBoundingClientRect();
  const localX = e.clientX - rect.left;
  const localY = e.clientY - rect.top;

  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;

  zoomAt(localX, localY, state.zoom * factor);
}, { passive: false });

// --- Клик по карте ---

canvas.addEventListener("click", (event) => {
  if (dragMoved) {
    dragMoved = false;
    return;
  }

  if (state.gameOver) {
    return;
  }

  const tile = getTileFromClick(event);

  if (!tile) {
    return;
  }

  const clickedUnit = getUnitAtTile(state.units, tile.x, tile.y);

  if (clickedUnit && clickedUnit === state.selectedUnit) {
    state.selectedUnit = null;
    state.selectedTile = null;
    state.reachableTiles = new Map();
    state.attackableTiles = new Map();

    updateInfo();
    updateRecruitPanel();
    drawGame();
    return;
  }

  if (
    isMyTurn() &&
    canAttackUnit(state.selectedUnit, clickedUnit)
  ) {
    const action = {
      kind: "attack",
      attackerId: state.selectedUnit.id,
      targetId: clickedUnit.id
    };

    if (runAction(action)) {
      sendAction(action);
    }

    return;
  }

  if (clickedUnit) {
    state.selectedUnit = clickedUnit;
    state.selectedTile = tile;
    updateSelectionHighlights();
    updateInfo();
    updateRecruitPanel();
    drawGame();
    return;
  }

  if (state.selectedUnit && isMyTurn()) {
    const action = {
      kind: "move",
      unitId: state.selectedUnit.id,
      x: tile.x,
      y: tile.y
    };

    if (runAction(action)) {
      sendAction(action);
      return;
    }
  }

  state.selectedUnit = null;
  state.selectedTile = tile;
  updateSelectionHighlights();
  updateInfo();
  updateRecruitPanel();
  drawGame();
});

// --- Кнопка завершения хода ---

endTurnButton.addEventListener("click", () => {
  if (!isMyTurn() || state.gameOver) {
    return;
  }

  const action = { kind: "endTurn" };

  if (runAction(action)) {
    sendAction(action);
  }
});

// --- Смена языка ---

langSelect.addEventListener("change", () => {
  setLanguage(langSelect.value);
  applyLanguage();
});

// --- Сыграть ещё раз ---

playAgainButton.addEventListener("click", () => {
  location.reload();
});

// --- Сеть ---

// ФИКС: connectionLost обрабатывается отдельно от opponentLeft
onNetworkMessage((message) => {
  if (message.type === "gameAction") {
    runAction(message.action);
  } else if (message.type === "opponentLeft") {
    handleOpponentLeft();
  } else if (message.type === "connectionLost") {
    handleConnectionLost();
  }
});

// --- Старт лобби ---

initLobby({
  onGameStart: () => {
    showScreen("gameScreen");
    initCamera();
    initGame(canvas, ctx);
    applyLanguage();
    startTurnTimer();
  }
});
