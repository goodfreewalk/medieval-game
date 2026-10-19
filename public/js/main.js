import {
  state,
  initGame,
  resetState,
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
  eliminatePlayer
} from "./logic.js";

// --- Элементы DOM ---

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const info = document.getElementById("info");
const turnInfo = document.getElementById("turnInfo");
const timerElement = document.getElementById("timer");
const endTurnButton = document.getElementById("endTurn");
const saveGameBtn = document.getElementById("saveGameBtn");
const leaveGameBtn = document.getElementById("leaveGameBtn");
const resourcesElement = document.getElementById("resources");
const recruitPanel = document.getElementById("recruitPanel");
const langSelect = document.getElementById("lang");
const gameOverOverlay = document.getElementById("gameOverOverlay");
const gameOverText = document.getElementById("gameOverText");
const gameOverReason = document.getElementById("gameOverReason");
const playAgainButton = document.getElementById("playAgainBtn");

const netStatus = document.getElementById("netStatus");
const guestRequests = document.getElementById("guestRequests");
const gameContainer = document.getElementById("gameContainer");

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

// Защита от случайного выхода: второе нажатие в течение 3 секунд
let leaveArmed = false;
let leaveArmedTimer = null;

// --- Вспомогательные функции ---

function isMyTurn() {
  return state.currentPlayer === getMyPlayerId();
}

function sendAction(action) {
  sendMessage({ type: "gameAction", action });
}

// --- Панель заявок на место ---

function addGuestRequest(message) {
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
    turnInfo.textContent =
      `${t("seatLabel")} ${state.currentPlayer} — ${t("seatPassive")}`;
  } else if (kind === "bot") {
    turnInfo.textContent =
      `${t("seatLabel")} ${state.currentPlayer} — ${t("seatBot")}`;
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

      text += ` | 💰 +${isCastle ? 6 : 2} | 📦 +${isCastle ? 3 : 1}`;

      if (owner !== 0) {
        text += ` | 🚩 ${owner}`;
      }
    }

    info.textContent = text;
    return;
  }

  info.textContent = t("infoDefault");
}

// Закрыть окно найма и снять выделение
function closeRecruitPanel() {
  state.selectedTile = null;
  state.selectedUnit = null;
  state.reachableTiles = new Map();
  state.attackableTiles = new Map();

  updateRecruitPanel();
  updateInfo();
  drawGame();
}

// Окно найма: полупрозрачное окно поверх карты с крестиком
function updateRecruitPanel() {
  recruitPanel.innerHTML = "";

  const tile = state.selectedTile;

  const show =
    tile &&
    state.map &&
    !state.gameOver &&
    (state.map[tile.y][tile.x] === TERRAIN.CASTLE ||
      state.map[tile.y][tile.x] === TERRAIN.VILLAGE) &&
    getTileOwner(tile.x, tile.y) === getMyPlayerId() &&
    isMyTurn() &&
    !getUnitAtTile(state.units, tile.x, tile.y);

  recruitPanel.style.display = show ? "" : "none";

  if (!show) {
    return;
  }

  const header = document.createElement("div");
  header.className = "recruitHeader";

  const title = document.createElement("span");
  title.textContent = t("recruit");

  const close = document.createElement("button");
  close.className = "recruitClose";
  close.textContent = "✕";
  close.addEventListener("click", closeRecruitPanel);

  header.appendChild(title);
  header.appendChild(close);
  recruitPanel.appendChild(header);

  const terrain = state.map[tile.y][tile.x];

  const icons = {
    militia: "🪓",
    archer: "🏹",
    swordsman: "⚔️",
    lightCavalry: "🏇",
    heavyCavalry: "🏇️️",
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
      const action = { kind: "recruit", type, x: tile.x, y: tile.y };

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

// Боевое устранение: у места не осталось ни юнитов, ни зданий
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

  saveGameBtn.style.display =
    getMyPlayerId() === 1 && state.map && !state.gameOver ? "" : "none";

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

  if (!leaveArmed) {
    leaveGameBtn.textContent = t("leaveGame");
  }

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

  if (reason !== t("connectionLost") && getRoomCode()) {
    removeResumeCard(getRoomCode());
  }

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

// --- Выход из партии в главное меню ---

function leaveGame() {
  if (!leaveArmed) {
    leaveArmed = true;
    leaveGameBtn.textContent = t("leaveConfirm");
    leaveGameBtn.classList.add("danger");

    clearTimeout(leaveArmedTimer);
    leaveArmedTimer = setTimeout(() => {
      leaveArmed = false;
      leaveGameBtn.textContent = t("leaveGame");
      leaveGameBtn.classList.remove("danger");
    }, 3000);
    return;
  }

  clearTimeout(leaveArmedTimer);
  leaveArmed = false;
  leaveGameBtn.classList.remove("danger");
  leaveGameBtn.textContent = t("leaveGame");

  sendMessage({ type: "leaveRoom" });

  stopTurnTimer();
  clearGameSession();
  clearGuestRequests();
  setStickyStatus("");
  setNetStatus("");
  resetState();
  showScreen("menuScreen");
}

// --- Снапшот состояния ---

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

// --- Камера (мир в контексте, не в CSS) ---

let fitZoom = 1;
let minZoom = 0.25;
let maxZoom = 3;

// На телефоне в портрете вписанный вид делает клетки мелкими,
// поэтому стартуем с приближения и центрируем на столице игрока
const MOBILE_ZOOM = 1.6;

// Инлайн-стили побеждают любой CSS: игровой экран = весь viewport,
// контейнер карты = весь экран
function layoutGameScreen() {
  const gameScreen = document.getElementById("gameScreen");

  gameScreen.style.position = "fixed";
  gameScreen.style.inset = "0";
  gameScreen.style.overflow = "hidden";

  gameContainer.style.position = "absolute";
  gameContainer.style.inset = "0";
  gameContainer.style.width = "auto";
  gameContainer.style.height = "auto";
  gameContainer.style.margin = "0";
}

function worldSize() {
  return state.map ? state.map.length * state.tileSize : 0;
}

function isPortrait() {
  return state.viewH > state.viewW;
}

function computeFitZoom() {
  const w = worldSize();

  if (!w) {
    return;
  }

  fitZoom = Math.min(state.viewW / w, state.viewH / w);
  minZoom = fitZoom;
  // Потолок зума (твоя настройка: ×4). Подними цифру, если нужно сильнее
  maxZoom = fitZoom * 4;
}

// Границы: карта целиком в кадре — центрируем; приближена — не утаскиваем за экран
function clampCamera() {
  const scaled = worldSize() * state.zoom;

  if (scaled <= state.viewW) {
    state.panX = (state.viewW - scaled) / 2;
  } else {
    const minX = state.viewW - scaled;
    state.panX = Math.max(minX, Math.min(0, state.panX));
  }

  if (scaled <= state.viewH) {
    state.panY = (state.viewH - scaled) / 2;
  } else {
    const minY = state.viewH - scaled;
    state.panY = Math.max(minY, Math.min(0, state.panY));
  }
}

// Центр столицы текущего игрока в мировых координатах (px);
// фолбэк — центр мира, если замок не найден
function capitalWorldPoint() {
  const me = getMyPlayerId();
  const size = state.map.length;

  if (me) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (
          state.map[y][x] === TERRAIN.CASTLE &&
          getTileOwner(x, y) === me
        ) {
          return {
            x: x * state.tileSize + state.tileSize / 2,
            y: y * state.tileSize + state.tileSize / 2
          };
        }
      }
    }
  }

  const half = worldSize() / 2;
  return { x: half, y: half };
}

// Применение режима камеры:
//  - портрет + centerOnCapital: приближение и центр на столице игрока;
//  - иначе (десктоп/ландшафт): вписанный вид по центру мира.
function applyCameraMode(centerOnCapital) {
  if (!state.map) {
    return;
  }

  computeFitZoom();

  if (centerOnCapital && isPortrait()) {
    state.zoom = Math.min(maxZoom, fitZoom * MOBILE_ZOOM);
    const cap = capitalWorldPoint();
    state.panX = state.viewW / 2 - cap.x * state.zoom;
    state.panY = state.viewH / 2 - cap.y * state.zoom;
  } else {
    state.zoom = fitZoom;
    const scaled = worldSize() * state.zoom;
    state.panX = (state.viewW - scaled) / 2;
    state.panY = (state.viewH - scaled) / 2;
  }

  clampCamera();
  drawGame();
}

// Canvas получает физический размер от контейнера (с dpr).
// Обычный ресайз окна границы пересчитывает, но позицию НЕ сбрасывает,
// чтобы не дёргать камеру игрока на каждый resize.
function resizeCanvas() {
  const rect = gameContainer.getBoundingClientRect();

  if (rect.width === 0 || rect.height === 0) {
    return;
  }

  const dpr = window.devicePixelRatio || 1;

  state.viewW = Math.round(rect.width);
  state.viewH = Math.round(rect.height);
  state.dpr = dpr;

  canvas.width = Math.round(state.viewW * dpr);
  canvas.height = Math.round(state.viewH * dpr);
  canvas.style.width = `${state.viewW}px`;
  canvas.style.height = `${state.viewH}px`;

  if (state.map) {
    computeFitZoom();
    state.zoom = Math.max(minZoom, Math.min(maxZoom, state.zoom));
    clampCamera();
    drawGame();
  }
}

function initCamera() {
  resizeCanvas();
  applyCameraMode(true);
}

function zoomAt(localX, localY, newZoom) {
  const clamped = Math.max(minZoom, Math.min(maxZoom, newZoom));
  const worldX = (localX - state.panX) / state.zoom;
  const worldY = (localY - state.panY) / state.zoom;

  state.zoom = clamped;
  state.panX = localX - worldX * state.zoom;
  state.panY = localY - worldY * state.zoom;

  clampCamera();
  drawGame();
}

// Экранные координаты клика → клетка мира
function screenToTile(event) {
  if (!state.map) {
    return null;
  }

  const rect = canvas.getBoundingClientRect();
  const cssX = event.clientX - rect.left;
  const cssY = event.clientY - rect.top;

  const worldX = (cssX - state.panX) / state.zoom;
  const worldY = (cssY - state.panY) / state.zoom;

  const x = Math.floor(worldX / state.tileSize);
  const y = Math.floor(worldY / state.tileSize);
  const size = state.map.length;

  if (x < 0 || x >= size || y < 0 || y >= size) {
    return null;
  }

  return { x, y };
}

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

function getLocalPoint(clientX, clientY) {
  const rect = gameContainer.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
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

    clampCamera();
    drawGame();
    e.preventDefault();
  } else if (e.touches.length === 2) {
    const dist = getTouchDistance(e.touches);
    const mid = getLocalPoint(
      (e.touches[0].clientX + e.touches[1].clientX) / 2,
      (e.touches[0].clientY + e.touches[1].clientY) / 2
    );

    zoomAt(mid.x, mid.y, pinchStartZoom * (dist / pinchStartDist));
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

  e.preventDefault();

  isDragging = true;
  dragMoved = false;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragStartPanX = state.panX;
  dragStartPanY = state.panY;
  gameContainer.classList.add("dragging");
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

  clampCamera();
  drawGame();
});

window.addEventListener("mouseup", () => {
  isDragging = false;
  gameContainer.classList.remove("dragging");
});

gameContainer.addEventListener("wheel", (e) => {
  e.preventDefault();

  const local = getLocalPoint(e.clientX, e.clientY);
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;

  zoomAt(local.x, local.y, state.zoom * factor);
}, { passive: false });

// Стрелки двигают взгляд (камеру): вверх — верх карты, вниз — низ
const KEY_PAN_STEP = 80;

window.addEventListener("keydown", (e) => {
  if (!state.map || state.gameOver) {
    return;
  }

  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
    return;
  }

  let dx = 0;
  let dy = 0;

  if (e.key === "ArrowUp") {
    dy = KEY_PAN_STEP;
  } else if (e.key === "ArrowDown") {
    dy = -KEY_PAN_STEP;
  } else if (e.key === "ArrowLeft") {
    dx = KEY_PAN_STEP;
  } else if (e.key === "ArrowRight") {
    dx = -KEY_PAN_STEP;
  } else {
    return;
  }

  e.preventDefault();

  state.panX += dx;
  state.panY += dy;

  clampCamera();
  drawGame();
});

// --- Клик по карте ---

canvas.addEventListener("click", (event) => {
  if (dragMoved) {
    dragMoved = false;
    return;
  }

  if (state.gameOver) {
    return;
  }

  const tile = screenToTile(event);

  if (!tile) {
    return;
  }

  const clickedUnit = getUnitAtTile(state.units, tile.x, tile.y);

  // Повторный клик по уже выбранной пустой клетке — закрыть окно найма
  if (
    !clickedUnit &&
    state.selectedTile &&
    state.selectedTile.x === tile.x &&
    state.selectedTile.y === tile.y
  ) {
    closeRecruitPanel();
    return;
  }

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

  if (isMyTurn() && canAttackUnit(state.selectedUnit, clickedUnit)) {
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

saveGameBtn.addEventListener("click", () => {
  if (getMyPlayerId() !== 1 || !state.map || state.gameOver) {
    return;
  }

  sendMessage({ type: "saveGame", state: serializeState() });
});

leaveGameBtn.addEventListener("click", leaveGame);

// --- Смена языка / оверлей ---

langSelect.addEventListener("change", () => {
  setLanguage(langSelect.value);
  applyLanguage();
});

playAgainButton.addEventListener("click", () => {
  location.reload();
});

// --- Ресайз окна / ориентации ---

// Обычный ресайз: пересчёт границ без сброса позиции камеры
window.addEventListener("resize", () => {
  resizeCanvas();
});

// Поворот экрана: режим меняется (портрет <-> ландшафт) —
// пересчитываем границы и заново выбираем центр (столица / весь мир)
window.addEventListener("orientationchange", () => {
  setTimeout(() => {
    resizeCanvas();
    applyCameraMode(true);
  }, 100);
});

// --- Сеть ---

onNetworkMessage((message) => {
  if (message.type === "gameAction") {
    runAction(message.action);
  } else if (message.type === "autoEndTurn") {
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
    if (message.playerId === 1) {
      setStickyStatus(
        `${t("hostOffline")} ${getRoomCode()} — ${t("noSaveResume")}`
      );
    } else {
      setNetStatus(t("opponentDisconnected"));
    }
  } else if (message.type === "opponentReconnected") {
    if (message.playerId === 1) {
      setStickyStatus("");
    }
    setNetStatus("");
  } else if (message.type === "playerEliminated") {
    pendingEliminations.delete(message.playerId);
    eliminatePlayer(message.playerId, message.nextTurn);
    delete state.seatKinds[message.playerId];
    setNetStatus("");
    refreshGame();

    if (message.playerId === getMyPlayerId()) {
      showGameOver(t("eliminatedYou"));
    } else if (message.playerId === 1) {
      setStickyStatus(`${t("hostEliminated")} — ${t("noSaveResume")}`);
    } else if (state.gameOver) {
      showGameOver();
    }
  } else if (message.type === "requestState") {
    if (state.map) {
      sendMessage({ type: "fullState", state: serializeState() });
    }
  } else if (message.type === "saveOk") {
    upsertResumeCard(getRoomCode(), getMyPlayerId(), message.token);
    setNetStatus(t("gameSaved"));
    setTimeout(() => setNetStatus(""), 2500);
  } else if (message.type === "guestRequest") {
    addGuestRequest(message);
  } else if (message.type === "playerReturned") {
    if (Array.isArray(message.seats)) {
      state.seatKinds = {};

      for (const seat of message.seats) {
        state.seatKinds[seat.id] = seat.kind || "human";
      }
    }

    setNetStatus("");
    refreshGame();
  } else if (message.type === "gameOver") {
    if (!state.gameOver) {
      state.gameOver = true;
      state.winner = message.winner;
      refreshGame();
      showGameOver();
    }
  } else if (message.type === "fullState") {
    applyFullState(message.state);

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
    layoutGameScreen();

    state.canvas = canvas;
    state.ctx = ctx;

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

    leaveArmed = false;
    clearTimeout(leaveArmedTimer);
    leaveGameBtn.classList.remove("danger");
    leaveGameBtn.textContent = t("leaveGame");

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
    layoutGameScreen();

    state.canvas = canvas;
    state.ctx = ctx;

    initGame(canvas, ctx, {
      mapId: message.mapId,
      seats: seatIds
    });

    initCamera();
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