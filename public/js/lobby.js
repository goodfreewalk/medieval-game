import { t } from "./i18n.js";
import { showScreen } from "./screens.js";
import {
  onNetworkMessage,
  createRoom,
  joinRoom,
  setReady,
  startGame
} from "./network.js";

const menuTitle = document.getElementById("menuTitle");
const nickname = document.getElementById("nickname");
const createRoomBtn = document.getElementById("createRoomBtn");
const joinRoomBtn = document.getElementById("joinRoomBtn");
const roomCodeInput = document.getElementById("roomCodeInput");
const menuStatus = document.getElementById("menuStatus");

const lobbyTitle = document.getElementById("lobbyTitle");
const roomCodeDisplay = document.getElementById("roomCodeDisplay");
const playersLabel = document.getElementById("playersLabel");
const playerList = document.getElementById("playerList");
const readyBtn = document.getElementById("readyBtn");
const startBtn = document.getElementById("startBtn");
const lobbyStatus = document.getElementById("lobbyStatus");

let myPlayerId = null;
let isHost = false;
let currentRoomCode = "";
let players = [];
let myReady = false;
let onGameStartCallback = null;

// Тексты меню
function updateMenuLanguage() {
  menuTitle.textContent = t("menuTitle");
  nickname.placeholder = t("nickname");
  createRoomBtn.textContent = t("createRoom");
  joinRoomBtn.textContent = t("join");
  roomCodeInput.placeholder = t("roomCodePlaceholder");
}

// Тексты лобби и его содержимое
function renderLobby() {
  lobbyTitle.textContent = t("lobbyTitle");
  playersLabel.textContent = t("playersLabel");

  roomCodeDisplay.textContent = `${t("roomLabel")}: ${currentRoomCode}`;

  playerList.innerHTML = "";

  for (const player of players) {
    const li = document.createElement("li");

    const status = player.ready ? t("playerReady") : t("playerNotReady");
    const you = player.id === myPlayerId ? ` ${t("youMark")}` : "";

    li.textContent = `${player.name}${you} — ${status}`;
    playerList.appendChild(li);
  }

  readyBtn.textContent = myReady ? t("cancelReady") : t("ready");
  startBtn.textContent = t("startGame");
  startBtn.style.display = isHost ? "" : "none";

  const allReady =
    players.length === 2 && players.every(player => player.ready);

  startBtn.disabled = !allReady;

  if (players.length < 2) {
    lobbyStatus.textContent = t("waitingPlayers");
  } else if (!players.every(player => player.ready)) {
    lobbyStatus.textContent = t("waitingReady");
  } else if (!isHost) {
    lobbyStatus.textContent = t("waitingHost");
  } else {
    lobbyStatus.textContent = t("canStart");
  }
}

// Обработка сообщений сервера
function handleNetworkMessage(message) {
  if (message.type === "roomCreated" || message.type === "roomJoined") {
    myPlayerId = message.playerId;
    isHost = message.playerId === 1;
    currentRoomCode = message.roomCode;
    myReady = false;
    players = [];

    showScreen("lobbyScreen");
    renderLobby();
  }

  if (message.type === "roomUpdate") {
    players = message.players;

    const me = players.find(player => player.id === myPlayerId);
    myReady = me ? me.ready : false;

    renderLobby();
  }

  if (message.type === "error") {
    showScreen("menuScreen");
    menuStatus.textContent = t(message.code);
  }

  if (message.type === "roomClosed") {
    showScreen("menuScreen");
    menuStatus.textContent = t(message.code);
  }

  if (message.type === "gameStart") {
    if (onGameStartCallback) {
      onGameStartCallback();
    }
  }
}

// Возвращает номер игрока (1 или 2)
export function getMyPlayerId() {
  return myPlayerId;
}

// Инициализация лобби
export function initLobby(callbacks) {
  onGameStartCallback = callbacks.onGameStart;

  createRoomBtn.addEventListener("click", () => {
    const name = nickname.value.trim() || "Player";
    menuStatus.textContent = "";
    createRoom(name);
  });

  joinRoomBtn.addEventListener("click", () => {
    const code = roomCodeInput.value.trim().toUpperCase();
    const name = nickname.value.trim() || "Player";

    if (code.length !== 4) {
      menuStatus.textContent = t("enterCode");
      return;
    }

    menuStatus.textContent = "";
    joinRoom(code, name);
  });

  readyBtn.addEventListener("click", () => {
    myReady = !myReady;
    setReady(myReady);
  });

  startBtn.addEventListener("click", () => {
    startGame();
  });

  // Обновление текстов лобби при смене языка
  document.getElementById("lang").addEventListener("change", () => {
    updateMenuLanguage();
    renderLobby();
  });

  onNetworkMessage(handleNetworkMessage);

  updateMenuLanguage();
  renderLobby();
}