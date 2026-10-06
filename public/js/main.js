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
import {
  initLobby,
  getMyPlayerId,
  getRoomCode,
  upsertResumeCard,
  removeResumeCard
} from "./lobby.js";
import {
  onNetworkMessage,
  sendMessage,
  saveGameSession,
  clearGameSession
} from "./network.js";
import {
  updateSelectionHighlights,
  canAttackUnit,
  applyMove,
  applyAttack,
  applyRecruit,
  applyEndTurn,
  eliminatePlayer,
  getTileFromClick
} from "./logic.js";

// --- Элементы DOM ---

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const info = document.getElementById("info");
const turnInfo = document.getElementById("turnInfo");
const timerElement = document.getElementById("timer");
const endTurnButton = document.getElementById("endTurn");
const saveGameBtn = document.getElementById("saveGameBtn");
const resourcesElement = document.getElementById("resources");
const recruitPanel = document.getElementById("recruitPanel");
const langSelect = document.getElementById("lang");
const gameOverOverlay = document.getElementById("gameOverOverlay");
const gameOverText = document.getElementById("gameOverText");
const gameOverReason = document.getElementById("gameOverReason");
const playAgainButton = document.getElementById("playAgainBtn");

// Строка статуса сети (переподключение / ожидание / сохранения)
const netStatus = document.getElementById("netStatus");

// Панель заявок на место (вместо системного confirm)
const guestRequests = document.getElementById("guestRequests");
const pendingGuestRequests = new Map();

// «Липкий» статус: важное постоянное сообщение (например, «хост отключился»).
// Временные статусы его перекрывают, но при очистке оно возвращается.
let stickyStatus = "";

function setNetStatus(text) {
  if (netStatus) {
    netStatus.textContent = text !== "" ? text : stickyStatus;
  }
}

function setStickyStatus(text) {
  stickyStatus = text;

  if (netStatus) {
    netStatus.textContent = text;
  }
}

// --- Таймер хода ---

const TURN_TIME = 60;
let timerInterval = null;
let timeLeft = TURN_TIME;

// --- Служебное состояние клиента ---

// Заявки на устранение, уже отправленные серверу (защита от спама)
const pendingEliminations = new Set();

// Данные резюма, ждущие fullState
let pendingResume = null;

// Защита от повторной отправки gameOver
let gameOverSent = false;

// --- Вспомогательные функции ---

function isMyTurn() {
  return state.currentPlayer === getMyPlayerId();
}

function sendAction(action) {
  sendMessage({ type: "gameAction", action });
}

// --- Панель заявок на место ---

function addGuestRequest(message) {
  // Повторная заявка того же гостя — не дублируем
  if (pendingGuestRequests.has(message.guestId)) {
    return;
  }

  const card = document.createElement("div");
  card.className = "guestRequestCard";

  const title = document.createElement("div");
  title.textContent =
    `${t("guestRequestTitle")}: ${message.name} → ` +
    `${t("seatLabel")} ${message.seatId}`;
  card.appendChild(title);

  const row = document.createElement("div");
  row.className = "guestRequestRow";

  const acceptBtn = document.createElement("button");
  acceptBtn.textContent = t("acceptGuestBtn");
  acceptBtn.addEventListener("click", () => {
    sendMessage({
      type: "acceptGuest",
      guestId: message.guestId,
      seatId: message.seatId
    });
    removeGuestRequest(message.guestId);
  });

  const denyBtn = document.createElement("button");
  denyBtn.textContent = t("denyGuestBtn");
  denyBtn.addEventListener("click", () => {
    sendMessage({ type: "denyGuest", guestId: message.guestId });
    removeGuestRequest(message.guestId);
  });

  row.appendChild(acceptBtn);
  row.appendChild(denyBtn);
  card.appendChild(row);

  guestRequests.appendChild(card);
  pendingGuestRequests.set(message.guestId, card);
}

function removeGuestRequest(guestId) {
  const card = pendingGuestRequests.get(guestId);

  if (card) {
    card.remove();
    pendingGuestRequests.delete(guestId);
  }
}

function clearGuestRequests() {
  guestRequests.innerHTML = "";
  pendingGuestRequests.clear();
}

// --- Обновление интерфейса ---

function updateTurnInfo() {
  const kind = state.seatKinds[state.currentPlayer];

  if (isMyTurn()) {
    turnInfo.textContent = t("yourTurn");
  } else if (kind === "passive") {
    // Пассивное место: ход ведёт сервер
    turnInfo.textContent =
      `${t("seatLabel")} ${state.currentPlayer} — ${t("seatPassive")}`;
  } else {
    turnInfo.textContent = `${t("turn")}: ${state.currentPlayer}`;
  }

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
    if (!isMyTurn()) {
      stopTurnTimer();
      timerElement.textContent = "—";
      return;
    }

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

  // Три карточки: золото, доход, снабжение
  resourcesElement.innerHTML =
    `<div class="statCard">` +
    `<span class="statIcon">💰</span>` +
    `<span class="statValue">${getPlayerGold(player)}</span>` +
    `<span class="statLabel">${t("gold")}</span>` +
    `</div>` +
    `<div class="statCard">` +
    `<span class="statIcon">📈</span>` +
    `<span class="statValue">+${getIncome(player)}</span>` +
    `<span class="statLabel">${t("income")}</span>` +
    `</div>` +
    `<div class="statCard">` +
    `<span class="statIcon">📦</span>` +
    `<span class="statValue">${getSupplyUsed(player)}/${getSupplyCapacity(player)}</span>` +
    `<span class="statLabel">${t("supply")}</span>` +
    `</div>`;
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
    heavyCavalry: "🏇️⚔️",
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

// Боевое устранение: у места не осталось ни юнитов, ни зданий —
// сообщаем серверу, он исключит место из очерёдности у всех
function detectEliminations() {
  if (!state.map || state.gameOver) {
    return;
  }

  for (const key of Object.keys(state.players)) {
    const id = Number(key);

    if (state.eliminated.has(id) || pendingEliminations.has(id)) {
      continue;
    }

    const hasUnits = state.units.some(unit => unit.owner === id);

    if (hasUnits) {
      continue;
    }

    let hasTerritory = false;

    for (const owner of state.owners.values()) {
      if (owner === id) {
        hasTerritory = true;
        break;
      }
    }

    if (!hasTerritory) {
      pendingEliminations.add(id);
      sendMessage({ type: "reportElimination", playerId: id });
    }
  }
}

function refreshGame() {
  updateTurnInfo();
  updateResources();
  updateRecruitPanel();
  updateInfo();

  // Кнопка сохранения видна только хосту во время игры
  saveGameBtn.style.display =
    getMyPlayerId() === 1 && state.map && !state.gameOver ? "" : "none";

  // Предохранитель: если сервер считает НАШЕ место пассивным,
  // честно говорим об этом вместо молчаливого бесправия
  if (state.map && !state.gameOver &&
      state.seatKinds[getMyPlayerId()] === "passive") {
    setNetStatus(t("seatSelfPassive"));
  }

  detectEliminations();
  drawGame();
}

function applyLanguage() {
  langSelect.value = getLanguage();

  endTurnButton.textContent = t("endTurn");
  playAgainButton.textContent = t("playAgain");
  saveGameBtn.textContent = t("saveGame");

  refreshGame();

  if (state.gameOver) {
    showGameOver();
  }
}

function showGameOver(reason) {
  stopTurnTimer();
  clearGuestRequests();

  // При потере соединения сессию НЕ чистим: после перезагрузки
  // страницы игрок сможет вернуться в ещё живую комнату
  if (reason !== t("connectionLost")) {
    clearGameSession();
  }

  // Карточка сохранения больше не нужна (кроме случая потери связи:
  // там партия может продолжаться и пригодится возврат)
  if (reason !== t("connectionLost") && getRoomCode()) {
    removeResumeCard(getRoomCode());
  }

  // Сообщаем серверу, чтобы результат увидели все, включая выбывших
  if (state.map && !gameOverSent) {
    gameOverSent = true;
    sendMessage({ type: "gameOver", winner: state.winner });
  }

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

function handleOpponentLeft() {
  if (state.gameOver) {
    return;
  }

  state.gameOver = true;
  state.winner = getMyPlayerId();
  showGameOver(t("opponentLeft"));
}

// --- Обработка потери соединения ---

function handleConnectionLost() {
  stopTurnTimer();

  if (state.gameOver) {
    return;
  }

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

// --- Снапшот состояния для синхронизации и сохранений ---

function serializeState() {
  return {
    map: state.map,
    units: state.units,
    owners: Array.from(state.owners.entries()),
    players: state.players,
    currentPlayer: state.currentPlayer,
    gameOver: state.gameOver,
    winner: state.winner,
    eliminated: Array.from(state.eliminated),
    seatKinds: state.seatKinds
  };
}

function applyFullState(snapshot) {
  state.map = snapshot.map;
  state.units = snapshot.units;
  state.owners = new Map(snapshot.owners);
  state.players = snapshot.players;
  state.currentPlayer = snapshot.currentPlayer;
  state.gameOver = snapshot.gameOver;
  state.winner = snapshot.winner;
  state.eliminated = new Set(snapshot.eliminated || []);
  state.seatKinds = snapshot.seatKinds || {};

  state.selectedUnit = null;
  state.selectedTile = null;
  state.reachableTiles = new Map();
  state.attackableTiles = new Map();
}

// --- Выполнение действий ---

function runAction(action) {
  if (action.kind === "move") {
    const result = applyMove(action.unitId, action.x, action.y);

    if (result.success) {
      const movedUnit = state.units.find(u => u.id === action.unitId);

      if (movedUnit && state.selectedUnit === movedUnit) {
        state.selectedTile = { x: movedUnit.x, y: movedUnit.y };
      }

      updateSelectionHighlights();
      refreshGame();
    }

    return result.success;
  }

  if (action.kind === "attack") {
    const result = applyAttack(action.attackerId, action.targetId);

    if (result.success) {
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
      } else if (attackerAlive && state.selectedUnit) {
        const attacker = state.units.find(u => u.id === action.attackerId);

        if (attacker && state.selectedUnit === attacker) {
          state.selectedTile = { x: attacker.x, y: attacker.y };
        }
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

    // Сообщаем серверу, кто ходит следующим (единое правило реестра)
    action.next = state.currentPlayer;

    updateSelectionHighlights();
    refreshGame();

    if (state.gameOver) {
      showGameOver();
      return true;
    }

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

// --- Кнопки панели хода ---

endTurnButton.addEventListener("click", () => {
  if (!isMyTurn() || state.gameOver) {
    return;
  }

  const action = { kind: "endTurn" };

  if (runAction(action)) {
    sendAction(action);
  }
});

// Сохранение партии: только хост, только во время игры
saveGameBtn.addEventListener("click", () => {
  if (getMyPlayerId() !== 1 || !state.map || state.gameOver) {
    return;
  }

  sendMessage({ type: "saveGame", state: serializeState() });
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

onNetworkMessage((message) => {
  if (message.type === "gameAction") {
    runAction(message.action);
  } else if (message.type === "autoEndTurn") {
    // Сервер пропустил ход пассивного места — применяем локально
    if (!state.gameOver && state.currentPlayer === message.playerId) {
      runAction({ kind: "endTurn", auto: true });
    }
  } else if (message.type === "opponentLeft") {
    handleOpponentLeft();
  } else if (message.type === "connectionLost") {
    handleConnectionLost();
  } else if (message.type === "reconnecting") {
    setNetStatus(t("reconnecting"));
  } else if (message.type === "rejoinOk") {
    setNetStatus(t("syncingState"));
  } else if (message.type === "gameGone") {
    clearGameSession();

    if (state.map && !state.gameOver) {
      state.gameOver = true;
      showGameOver(t("gameAbandoned"));
    }
  } else if (message.type === "opponentDisconnected") {
    // Хост отключился: игра продолжается, но сохранение и возврат
    // умрут вместе с его ключом — честно предупреждаем остальных
    if (message.playerId === 1) {
      setStickyStatus(
        `${t("hostOffline")} ${getRoomCode()} — ${t("noSaveResume")}`
      );
    } else {
      setNetStatus(t("opponentDisconnected"));
    }
  } else if (message.type === "opponentReconnected") {
    // Хост вернулся в grace-окно — сохранение снова возможно
    if (message.playerId === 1) {
      setStickyStatus("");
    }
    setNetStatus("");
  } else if (message.type === "playerEliminated") {
    // Место выбыло (бой, обрыв, решение хоста): убираем юнитов,
    // нейтрализуем здания, сдвигаем очерёдность по подсказке сервера
    pendingEliminations.delete(message.playerId);
    eliminatePlayer(message.playerId, message.nextTurn);
    delete state.seatKinds[message.playerId];
    setNetStatus("");
    refreshGame();

    if (message.playerId === getMyPlayerId()) {
      showGameOver(t("eliminatedYou"));
    } else if (message.playerId === 1) {
      // Хост выбыл окончательно: ключ возврата потерян навсегда
      setStickyStatus(`${t("hostEliminated")} — ${t("noSaveResume")}`);
    } else if (state.gameOver) {
      showGameOver();
    }
  } else if (message.type === "requestState") {
    // Соперник вернулся — присылаем состояние, только если оно у нас есть
    if (state.map) {
      sendMessage({ type: "fullState", state: serializeState() });
    }
  } else if (message.type === "saveOk") {
    // Хост получил ключ возврата — обновляем карточку сохранения
    upsertResumeCard(getRoomCode(), getMyPlayerId(), message.token);
    setNetStatus(t("gameSaved"));
    setTimeout(() => setNetStatus(""), 2500);
  } else if (message.type === "guestRequest") {
    // Владелец пассив-места вернулся посреди партии:
    // хост решает через панель заявок (без системного confirm)
    addGuestRequest(message);
  } else if (message.type === "playerReturned") {
    // Сервер — источник истины о видах мест: принимаем реестр
    if (Array.isArray(message.seats)) {
      state.seatKinds = {};

      for (const seat of message.seats) {
        state.seatKinds[seat.id] = seat.kind || "human";
      }
    }

    setNetStatus("");
    refreshGame();
  } else if (message.type === "gameOver") {
    // Результат партии для всех, включая выбывших зрителей
    if (!state.gameOver) {
      state.gameOver = true;
      state.winner = message.winner;
      refreshGame();
      showGameOver();
    }
  } else if (message.type === "fullState") {
    applyFullState(message.state);

    // Резюм: устраняем выбранные хостом места и применяем виды мест
    if (pendingResume) {
      for (const id of pendingResume.eliminated) {
        eliminatePlayer(
          id,
          id === state.currentPlayer ? pendingResume.turn : null
        );
      }

      state.seatKinds = pendingResume.seatKinds;
      pendingResume = null;
    }

    showScreen("gameScreen");

    if (!state.canvas) {
      state.canvas = canvas;
      state.ctx = ctx;
    }

    state.tileSize = canvas.width / state.map.length;
    initCamera();

    setNetStatus("");
    refreshGame();

    if (state.gameOver) {
      showGameOver();
    } else if (isMyTurn()) {
      startTurnTimer();
    } else {
      stopTurnTimer();
      timerElement.textContent = "—";
    }
  }
});

// --- Старт лобби ---

initLobby({
  onGameStart: (message) => {
    gameOverSent = false;
    pendingEliminations.clear();
    clearGuestRequests();
    setStickyStatus("");

    // message.seats: [{ id, kind }] в игре и резюме
    const seatIds = [];
    const seatKinds = {};

    for (const seat of message.seats || []) {
      if (seat && typeof seat === "object") {
        seatIds.push(seat.id);
        seatKinds[seat.id] = seat.kind || "human";
      } else {
        seatIds.push(seat);
        seatKinds[seat] = "human";
      }
    }

    if (message.resume) {
      // Резюм: состояние придёт следующим сообщением fullState
      pendingResume = {
        eliminated: message.eliminated || [],
        turn: message.turn,
        seatKinds
      };

      saveGameSession(getRoomCode(), getMyPlayerId());
      upsertResumeCard(getRoomCode(), getMyPlayerId(), null);
      applyLanguage();
      return;
    }

    state.seatKinds = seatKinds;

    showScreen("gameScreen");
    initCamera();
    initGame(canvas, ctx, {
      mapId: message.mapId,
      seats: seatIds
    });
    applyLanguage();

    saveGameSession(getRoomCode(), getMyPlayerId());
    upsertResumeCard(getRoomCode(), getMyPlayerId(), null);

    if (isMyTurn()) {
      startTurnTimer();
    } else {
      stopTurnTimer();
      timerElement.textContent = "—";
    }
  }
});

// Кнопка сохранения скрыта до старта игры
saveGameBtn.style.display = "none";