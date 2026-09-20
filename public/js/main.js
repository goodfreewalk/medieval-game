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
  PLAYER_COLORS,
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

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const info = document.getElementById("info");
const title = document.getElementById("title");
const langSelect = document.getElementById("lang");
const turnInfo = document.getElementById("turnInfo");
const endTurnButton = document.getElementById("endTurn");
const resources = document.getElementById("resources");
const recruitPanel = document.getElementById("recruitPanel");
const gameOverOverlay = document.getElementById("gameOverOverlay");
const gameOverText = document.getElementById("gameOverText");
const playAgainBtn = document.getElementById("playAgainBtn");
const timerEl = document.getElementById("timer");

// Таймер хода
const TURN_TIME = 60;
let turnTimer = null;
let timeLeft = TURN_TIME;

initGame(canvas, ctx);

// Мой ход или нет
function isMyTurn() {
  return state.currentPlayer === getMyPlayerId();
}

// --- Таймер ---

function updateTimerDisplay() {
  timerEl.textContent = `${timeLeft}`;

  if (timeLeft <= 10) {
    timerEl.classList.add("warning");
  } else {
    timerEl.classList.remove("warning");
  }
}

function stopTurnTimer() {
  if (turnTimer) {
    clearInterval(turnTimer);
    turnTimer = null;
  }
}

function startTurnTimer() {
  stopTurnTimer();
  timeLeft = TURN_TIME;
  updateTimerDisplay();

  turnTimer = setInterval(() => {
    timeLeft--;
    updateTimerDisplay();

    if (timeLeft <= 0) {
      // Ход автоматически завершает только тот, чей сейчас ход
      if (isMyTurn()) {
        doEndTurn();
      }
    }
  }, 1000);
}

// --- Обновление интерфейса ---

function updateInfo() {
  if (state.selectedUnit) {
    const unit = state.selectedUnit;
    const maxMovement = UNIT_TYPES[unit.type].movement;

    let text =
      `${t("unitLabel")}: ${unitName(unit.type)} | ` +
      `${t("player")}: ${unit.owner} | ` +
      `${t("health")}: ${unit.hp} | ` +
      `${t("movement")}: ${unit.movementLeft}`;

    if (unit.owner === state.currentPlayer) {
      if (unit.hasAttacked) {
        text += ` | ${t("acted")}`;
      } else if (unit.movementLeft < maxMovement) {
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

    let text =
      `${t("cell")}: ${state.selectedTile.x}, ${state.selectedTile.y} | ` +
      `${t("type")}: ${terrainName(terrain)}`;

    if (!isPassable) {
      text += ` | ${t("moveCost")}: ∞`;
    } else {
      text += ` | ${t("moveCost")}: ${terrainCost}`;
    }

    if (terrainDef > 0) {
      text += ` | ${t("defenseBonus")}: +${terrainDef}`;
    }

    if (terrain === TERRAIN.VILLAGE || terrain === TERRAIN.CASTLE) {
      const owner = getTileOwner(state.selectedTile.x, state.selectedTile.y);
      const isCastle = terrain === TERRAIN.CASTLE;

      const gold = isCastle ? 6 : 2;
      const supply = isCastle ? 3 : 1;

      text += ` | ${t("gold")}: +${gold} | ${t("supply")}: +${supply}`;

      if (owner === 0) {
        text += ` | ${t("player")}: —`;
      } else {
        text += ` | ${t("player")}: ${owner}`;
      }
    }

    info.textContent = text;
    return;
  }

  info.textContent = t("infoDefault");
}

function updateTurnInfo() {
  turnInfo.textContent = `${t("currentPlayer")}: ${state.currentPlayer}`;
  turnInfo.style.backgroundColor = PLAYER_COLORS[state.currentPlayer];
  endTurnButton.textContent = t("endTurn");
  endTurnButton.disabled = !isMyTurn();
}

function updateResourceInfo() {
  const player = state.currentPlayer;

  const gold = getPlayerGold(player);
  const income = getIncome(player);
  const supplyUsed = getSupplyUsed(player);
  const supplyCapacity = getSupplyCapacity(player);

  resources.textContent =
    `${t("gold")}: ${gold} | ` +
    `${t("income")}: +${income} | ` +
    `${t("supply")}: ${supplyUsed}/${supplyCapacity}`;
}

function updateRecruitPanel() {
  recruitPanel.innerHTML = "";

  if (state.gameOver) {
    return;
  }

  if (!isMyTurn()) {
    return;
  }

  if (!state.selectedTile) {
    return;
  }

  const tile = state.selectedTile;
  const terrain = state.map[tile.y][tile.x];

  if (terrain !== TERRAIN.CASTLE && terrain !== TERRAIN.VILLAGE) {
    return;
  }

  const owner = getTileOwner(tile.x, tile.y);

  if (owner !== state.currentPlayer) {
    return;
  }

  if (getUnitAtTile(state.units, tile.x, tile.y)) {
    return;
  }

  const player = state.currentPlayer;
  const gold = getPlayerGold(player);
  const supplyUsed = getSupplyUsed(player);
  const supplyCapacity = getSupplyCapacity(player);
  const supplyFull = supplyUsed >= supplyCapacity;

  let recruitableTypes;
  if (terrain === TERRAIN.CASTLE) {
    recruitableTypes = Object.keys(UNIT_TYPES);
  } else {
    recruitableTypes = ["militia"];
  }

  for (const type of recruitableTypes) {
    const unitType = UNIT_TYPES[type];

    const button = document.createElement("button");
    button.className = "recruitButton";
    button.textContent = `${unitName(type)} (${unitType.cost})`;

    button.disabled = gold < unitType.cost || supplyFull;

    button.addEventListener("click", () => {
      const action = {
        kind: "recruit",
        unitType: type,
        x: tile.x,
        y: tile.y
      };

      if (runAction(action)) {
        sendAction(action);
      }
    });

    recruitPanel.appendChild(button);
  }
}

function showGameOver() {
  if (!state.gameOver) {
    return;
  }

  stopTurnTimer();

  gameOverOverlay.classList.remove("hidden");

  if (state.winner === null) {
    gameOverText.textContent = t("draw");
  } else {
    gameOverText.textContent =
      `${t("player")} ${state.winner} ${t("wins")}`;
  }

  playAgainBtn.textContent = t("playAgain");
}

function applyLanguage() {
  langSelect.value = getLanguage();
  title.textContent = t("title");

  refreshGame();

  if (state.gameOver) {
    showGameOver();
  }
}

// Полное обновление игрового интерфейса
function refreshGame() {
  updateTurnInfo();
  updateResourceInfo();
  updateInfo();
  updateRecruitPanel();
  drawGame();
}

// --- Действия ---

function sendAction(action) {
  sendMessage({ type: "gameAction", action });
}

// Применяет действие (и своё, и чужое)
function runAction(action) {
  if (action.kind === "move") {
    const result = applyMove(action.unitId, action.x, action.y);

    if (!result.success) {
      return false;
    }

    const unit = state.units.find(u => u.id === action.unitId);

    state.selectedUnit = unit || null;
    state.selectedTile = { x: action.x, y: action.y };

    updateSelectionHighlights();
    refreshGame();
    return true;
  }

  if (action.kind === "attack") {
    const result = applyAttack(action.attackerId, action.targetId);

    if (!result.success) {
      return false;
    }

    const attacker = state.units.find(u => u.id === action.attackerId);

    if (attacker) {
      state.selectedUnit = attacker;
      state.selectedTile = { x: attacker.x, y: attacker.y };
    } else {
      state.selectedUnit = null;
      state.selectedTile = null;
    }

    updateSelectionHighlights();

    let text = `${t("damage")}: ${result.damageToDefender}`;

    if (result.damageToAttacker > 0) {
      text += ` | ${t("counter")}: ${result.damageToAttacker}`;
    }

    if (result.defenderDestroyed) {
      text += ` | ${t("defenderLost")}`;
    }

    if (result.attackerDestroyed) {
      text += ` | ${t("attackerLost")}`;
    }

    info.textContent = text;

    refreshGame();

    if (state.gameOver) {
      showGameOver();
    }

    return true;
  }

  if (action.kind === "recruit") {
    const result = applyRecruit(action.unitType, action.x, action.y);

    if (!result.success) {
      return false;
    }

    info.textContent = t("recruited");

    state.selectedUnit = null;
    state.selectedTile = { x: action.x, y: action.y };

    refreshGame();
    return true;
  }

  if (action.kind === "endTurn") {
    applyEndTurn();

    refreshGame();

    if (state.gameOver) {
      showGameOver();
    } else {
      startTurnTimer();
    }

    return true;
  }

  return false;
}

// Завершение хода
function doEndTurn() {
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

// Получаем сообщения от сервера
onNetworkMessage((message) => {
  if (message.type === "gameAction") {
    runAction(message.action);
  }

  // Противник отключился во время игры
  if (message.type === "opponentLeft") {
    state.gameOver = true;
    state.winner = getMyPlayerId();

    document.getElementById("gameOverReason").textContent =
      t("opponentLeft");

    showGameOver();
  }
});

// --- Обработчики ---

canvas.addEventListener("click", (event) => {
  if (state.gameOver) {
    return;
  }

  const tile = getTileFromClick(event);

  if (!tile) {
    return;
  }

  const clickedUnit = getUnitAtTile(state.units, tile.x, tile.y);

  // Повторный клик по уже выбранному юниту — снять выделение
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

  // Если кликнули по врагу и можно атаковать — атакуем
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

  // Если кликнули по юниту — выбираем юнита
  if (clickedUnit) {
    state.selectedUnit = clickedUnit;
    state.selectedTile = tile;
    updateSelectionHighlights();
    updateInfo();
    updateRecruitPanel();
    drawGame();
    return;
  }

  // Если выбран юнит и клик по доступной клетке — двигаем юнита
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

  // Иначе просто выбираем клетку
  state.selectedUnit = null;
  state.selectedTile = tile;
  updateSelectionHighlights();
  updateInfo();
  updateRecruitPanel();
  drawGame();
});

endTurnButton.addEventListener("click", doEndTurn);

playAgainBtn.addEventListener("click", () => {
  location.reload();
});

langSelect.addEventListener("change", () => {
  setLanguage(langSelect.value);
  applyLanguage();
});

// --- Лобби и старт игры ---

initLobby({
  onGameStart: () => {
    showScreen("gameScreen");
    initGame(canvas, ctx);
    applyLanguage();
    startTurnTimer();
  }
});

// --- Запуск ---

applyLanguage();