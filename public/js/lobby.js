import { t } from "./i18n.js";
import { showScreen } from "./screens.js";
import { MAPS, getMapById } from "./maps.js";
import { PLAYER_COLORS } from "./units.js";
import {
  onNetworkMessage,
  createRoom,
  joinRoom,
  setReady,
  startGame,
  leaveRoom,
  sendMessage
} from "./network.js";

const menuTitle = document.getElementById("menuTitle");
const nickname = document.getElementById("nickname");
const createRoomBtn = document.getElementById("createRoomBtn");
const joinRoomBtn = document.getElementById("joinRoomBtn");
const roomCodeInput = document.getElementById("roomCodeInput");
const menuStatus = document.getElementById("menuStatus");
const resumeCards = document.getElementById("resumeCards");
const lobbyTitle = document.getElementById("lobbyTitle");
const roomCodeDisplay = document.getElementById("roomCodeDisplay");
const playersLabel = document.getElementById("playersLabel");
const playerList = document.getElementById("playerList");
const readyBtn = document.getElementById("readyBtn");
const startBtn = document.getElementById("startBtn");
const leaveRoomBtn = document.getElementById("leaveRoomBtn");
const lobbyStatus = document.getElementById("lobbyStatus");
const mapLabel = document.getElementById("mapLabel");
const mapSelect = document.getElementById("mapSelect");
const mapPreview = document.getElementById("mapPreview");
const mapInfo = document.getElementById("mapInfo");

let myPlayerId = null;
let myGuestId = null;
let isHost = false;
let currentRoomCode = "";
let currentMapId = "classic";
let currentResumeLobby = false;
let lastSeatDraft = {};
let lastGuests = [];
let lastSaveInfo = null;
let players = [];
let myReady = false;
let onGameStartCallback = null;

// ---------- Карточки сохранённых партий (localStorage) ----------

const RESUME_CARDS_KEY = "resumeCards";

function getResumeCards() {
  try {
    return JSON.parse(localStorage.getItem(RESUME_CARDS_KEY)) || [];
  } catch {
    return [];
  }
}

function saveResumeCards(cards) {
  try {
    localStorage.setItem(RESUME_CARDS_KEY, JSON.stringify(cards));
  } catch {
    // localStorage может быть недоступен — не критично
  }
}

export function upsertResumeCard(code, seatId, token) {
  if (!code) {
    return;
  }

  const cards = getResumeCards();
  const existing = cards.find(card => card.code === code);

  if (existing) {
    existing.seatId = seatId || existing.seatId;
    existing.date = Date.now();
    if (token) {
      existing.token = token;
    }
  } else {
    cards.push({
      code,
      seatId: seatId || null,
      token: token || null,
      date: Date.now()
    });
  }

  saveResumeCards(cards);
  renderResumeCards();
}

export function removeResumeCard(code) {
  saveResumeCards(getResumeCards().filter(card => card.code !== code));
  renderResumeCards();
}

function renderResumeCards() {
  resumeCards.innerHTML = "";

  const cards = getResumeCards();

  if (cards.length === 0) {
    return;
  }

  const title = document.createElement("div");
  title.textContent = t("resumeCardsTitle");
  title.style.fontSize = "13px";
  title.style.color = "#dddddd";
  resumeCards.appendChild(title);

  for (const card of cards) {
    const row = document.createElement("div");
    row.className = "resumeCard";

    const button = document.createElement("button");
    button.className = "resumeCardButton";

    if (card.token) {
      // Хост: открывает лобби возврата по ключу
      button.textContent = `${t("resumeHostCard")} · ${card.code}`;
      button.addEventListener("click", () => {
        const name = nickname.value.trim() || "Player";
        menuStatus.textContent = "";
        sendMessage({
          type: "resumeGame",
          roomCode: card.code,
          token: card.token,
          name
        });
      });
    } else {
      // Игрок: входит в уже открытое хостом лобби возврата
      button.textContent =
        `${t("resumeJoinCard")} · ${card.code} · ${t("seatLabel")} ${card.seatId}`;
      button.addEventListener("click", () => {
        const name = nickname.value.trim() || "Player";
        menuStatus.textContent = "";
        joinRoom(card.code, name, card.seatId);
      });
    }

    const remove = document.createElement("button");
    remove.className = "resumeCardDelete";
    remove.textContent = "✕";
    remove.addEventListener("click", () => {
      removeResumeCard(card.code);
    });

    row.appendChild(button);
    row.appendChild(remove);
    resumeCards.appendChild(row);
  }
}

// ---------- Превью карты ----------

const PREVIEW_COLORS = {
  ".": "#7bb546",
  F: "#4e8f3a",
  H: "#b0a06a",
  W: "#3d85c8",
  M: "#8d8d8d",
  C: "#7bb546",
  V: "#7bb546",
  1: PLAYER_COLORS[1],
  2: PLAYER_COLORS[2],
  3: PLAYER_COLORS[3],
  4: PLAYER_COLORS[4],
  a: "#7bb546",
  b: "#7bb546",
  c: "#7bb546",
  d: "#7bb546"
};

function renderMapPreview(mapDef) {
  const ctxPreview = mapPreview.getContext("2d");
  const size = mapDef.rows.length;
  const cell = mapPreview.width / size;

  ctxPreview.clearRect(0, 0, mapPreview.width, mapPreview.height);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const char = mapDef.rows[y][x] || ".";

      ctxPreview.fillStyle = PREVIEW_COLORS[char] || "#7bb546";
      ctxPreview.fillRect(x * cell, y * cell, cell, cell);

      if (char === "C" || char === "V") {
        ctxPreview.fillStyle = "#ffffff";
        ctxPreview.fillRect(
          x * cell + cell * 0.3,
          y * cell + cell * 0.3,
          cell * 0.4,
          cell * 0.4
        );
      }

      const villageIndex = "abcd".indexOf(char);

      if (villageIndex !== -1) {
        ctxPreview.fillStyle = PLAYER_COLORS[villageIndex + 1];
        ctxPreview.fillRect(
          x * cell + cell * 0.25,
          y * cell + cell * 0.25,
          cell * 0.5,
          cell * 0.5
        );
      }
    }
  }
}

function availableMaps() {
  if (currentResumeLobby) {
    return [getMapById(currentMapId)];
  }

  const count = players.length || 2;
  const list = MAPS.filter(map => map.players.includes(count));
  return list.length > 0 ? list : MAPS;
}

function renderMapSelect() {
  const list = availableMaps();

  if (!list.some(map => map.id === currentMapId)) {
    currentMapId = list[0].id;

    if (isHost && !currentResumeLobby) {
      sendMessage({ type: "setMap", mapId: currentMapId });
    }
  }

  // В лобби возврата карта фиксирована сохранением
  const locked = currentResumeLobby;
  mapSelect.style.display = locked ? "none" : "";
  mapLabel.style.display = locked ? "none" : "";

  mapLabel.textContent = t("mapLabel");
  mapSelect.innerHTML = "";

  for (const map of list) {
    const option = document.createElement("option");
    option.value = map.id;
    option.textContent = `${t(map.nameKey)} (${map.rows.length}×${map.rows.length})`;
    mapSelect.appendChild(option);
  }

  mapSelect.value = currentMapId;
  mapSelect.disabled = !isHost;

  const current = getMapById(currentMapId);
  renderMapPreview(current);
  mapInfo.textContent =
    `${t(current.nameKey)} · ${t("mapPlayers")}: ${current.players.join(", ")}`;
}

// ---------- Лобби ----------

function guestName(guestId) {
  const guest = lastGuests.find(g => g.guestId === guestId);
  return guest ? guest.name : "—";
}

// Лобби возврата: хост раздаёт места, гости ждут
function renderResumeLobby() {
  lobbyTitle.textContent = t("lobbyTitle");
  roomCodeDisplay.textContent = `${t("roomLabel")}: ${currentRoomCode}`;
  leaveRoomBtn.textContent = t("leaveRoom");

  renderMapSelect();

  readyBtn.style.display = "none";
  startBtn.style.display = isHost ? "" : "none";
  startBtn.textContent = t("startGame");
  startBtn.disabled = !isHost;

  playerList.innerHTML = "";

  const savedSeats = (lastSaveInfo && lastSaveInfo.seats) || [];

  for (const seat of savedSeats) {
    const li = document.createElement("li");
    const draft = lastSeatDraft[seat.id] || { kind: "passive" };

    let statusText = "";

    if (draft.kind === "passive") {
      statusText = t("seatPassive");
    } else if (draft.kind === "eliminate") {
      statusText = t("seatEliminate");
    } else if (seat.id === 1) {
      const host = players.find(p => p.id === 1);
      statusText = `${t("seatHuman")}: ${host ? host.name : "—"}`;
    } else {
      statusText = `${t("seatHuman")}: ${guestName(draft.guestId)}`;
    }

    li.textContent = `${t("seatLabel")} ${seat.id} (${seat.name || "?"}) — ${statusText} `;

    if (isHost && seat.id !== 1) {
      const select = document.createElement("select");

      // Гости пула
      for (const guest of lastGuests) {
        const option = document.createElement("option");
        option.value = `guest:${guest.guestId}`;
        option.textContent = guest.name;
        select.appendChild(option);
      }

      const passiveOption = document.createElement("option");
      passiveOption.value = "passive";
      passiveOption.textContent = t("seatPassive");
      select.appendChild(passiveOption);

      const eliminateOption = document.createElement("option");
      eliminateOption.value = "eliminate";
      eliminateOption.textContent = t("seatEliminate");
      select.appendChild(eliminateOption);

      const botOption = document.createElement("option");
      botOption.value = "bot";
      botOption.textContent = t("seatBot");
      botOption.disabled = true;
      select.appendChild(botOption);

      // Текущий выбор
      if (draft.kind === "human" && draft.guestId !== null) {
        select.value = `guest:${draft.guestId}`;
      } else {
        select.value = draft.kind;
      }

      select.addEventListener("change", () => {
        const value = select.value;

        if (value.startsWith("guest:")) {
          sendMessage({
            type: "setSeat",
            seatId: seat.id,
            kind: "human",
            guestId: Number(value.slice(6))
          });
        } else {
          sendMessage({
            type: "setSeat",
            seatId: seat.id,
            kind: value
          });
        }
      });

      li.appendChild(select);
    }

    playerList.appendChild(li);
  }

  // Нераспределённые гости
  const seatedGuestIds = new Set(
    Object.values(lastSeatDraft)
      .filter(d => d.kind === "human" && d.guestId !== null)
      .map(d => d.guestId)
  );

  for (const guest of lastGuests) {
    if (seatedGuestIds.has(guest.guestId)) {
      continue;
    }

    const li = document.createElement("li");
    li.textContent = `${guest.name} — ${t("waitingHost")}`;
    playerList.appendChild(li);
  }

  lobbyStatus.textContent = isHost ? t("canStart") : t("resumeWaitingHost");
}

function renderLobby() {
  if (currentResumeLobby) {
    renderResumeLobby();
    return;
  }

  lobbyTitle.textContent = t("lobbyTitle");
  playersLabel.textContent = t("playersLabel");
  roomCodeDisplay.textContent = `${t("roomLabel")}: ${currentRoomCode}`;
  leaveRoomBtn.textContent = t("leaveRoom");

  readyBtn.style.display = "";
  renderMapSelect();

  playerList.innerHTML = "";

  for (const player of players) {
    const li = document.createElement("li");
    const status = player.ready ? t("playerReady") : t("playerNotReady");
    const you = player.id === myPlayerId ? ` ${t("youMark")}` : "";
    li.textContent = `${player.id}. ${player.name}${you} — ${status}`;
    playerList.appendChild(li);
  }

  readyBtn.textContent = myReady ? t("cancelReady") : t("ready");
  startBtn.textContent = t("startGame");
  startBtn.style.display = isHost ? "" : "none";

  const allReady =
    players.length >= 2 && players.every(player => player.ready);
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

// ---------- Сеть ----------

function handleNetworkMessage(message) {
  if (message.type === "roomCreated" || message.type === "roomJoined") {
    myPlayerId = message.playerId;
    myGuestId = message.guestId !== undefined ? message.guestId : null;
    isHost = message.playerId === 1;
    currentRoomCode = message.roomCode;
    currentMapId = message.mapId || currentMapId;
    currentResumeLobby = !!message.resumeLobby;
    myReady = false;

    if (!currentResumeLobby) {
      players = [];
    }

    showScreen("lobbyScreen");
    renderLobby();
  }

  if (message.type === "rejoinOk") {
    myPlayerId = message.playerId;
    isHost = message.playerId === 1;
    currentRoomCode = message.roomCode;
    myReady = false;
  }

  if (message.type === "roomUpdate") {
    players = message.players;
    currentMapId = message.mapId || currentMapId;
    currentResumeLobby = !!message.resumeLobby;
    lastSeatDraft = message.seatDraft || {};
    lastGuests = message.guests || [];
    lastSaveInfo = message.saveInfo || null;

    const me = players.find(player => player.id === myPlayerId);
    myReady = me ? me.ready : false;
    renderLobby();
  }

  if (message.type === "error") {
    // Битые сохранения убираем из карточек сразу
    if (
      message.code === "saveNotFound" ||
      message.code === "saveIncompatible"
    ) {
      removeResumeCard(currentRoomCode || roomCodeInput.value.trim().toUpperCase());
    }

    showScreen("menuScreen");
    menuStatus.textContent = t(message.code);
    renderResumeCards();
  }

  if (message.type === "roomClosed") {
    showScreen("menuScreen");
    menuStatus.textContent = t(message.code);
  }

  if (message.type === "resumeStartedWithoutYou") {
    myGuestId = null;
    showScreen("menuScreen");
    menuStatus.textContent = t("startedWithoutYou");
  }

  if (message.type === "waitingApproval") {
    showScreen("menuScreen");
    menuStatus.textContent = t("waitingApproval");
  }

  if (message.type === "guestRequestDenied") {
    showScreen("menuScreen");
    menuStatus.textContent = t("guestRequestDenied");
  }

  if (message.type === "gameStart") {
    if (onGameStartCallback) {
      onGameStartCallback(message);
    }
  }
}

// ---------- Экспорты ----------

export function getRoomCode() {
  return currentRoomCode;
}

export function getMyPlayerId() {
  return myPlayerId;
}

// ---------- Инициализация ----------

export function initLobby(callbacks) {
  onGameStartCallback = callbacks.onGameStart;

  function applyTelegram() {
    const tg = window.Telegram.WebApp;

    tg.ready();
    tg.expand();
    tg.setHeaderColor("#222222");
    tg.setBackgroundColor("#222222");

    const user = tg.initDataUnsafe && tg.initDataUnsafe.user;

    if (user && user.first_name) {
      nickname.value = user.first_name;
    }
  }

  if (window.Telegram && window.Telegram.WebApp) {
    applyTelegram();
  } else {
    let telegramWaited = 0;
    const telegramTimer = setInterval(() => {
      telegramWaited += 100;

      if (window.Telegram && window.Telegram.WebApp) {
        clearInterval(telegramTimer);
        applyTelegram();
      } else if (telegramWaited >= 2000) {
        clearInterval(telegramTimer);
      }
    }, 100);
  }

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
    if (currentResumeLobby) {
      sendMessage({ type: "startResumeGame" });
    } else {
      startGame();
    }
  });

  leaveRoomBtn.addEventListener("click", () => {
    leaveRoom();

    myPlayerId = null;
    myGuestId = null;
    isHost = false;
    currentRoomCode = "";
    currentResumeLobby = false;
    players = [];
    myReady = false;

    menuStatus.textContent = "";
    showScreen("menuScreen");
    renderResumeCards();
  });

  mapSelect.addEventListener("change", () => {
    if (!isHost || currentResumeLobby) {
      return;
    }

    currentMapId = mapSelect.value;
    sendMessage({ type: "setMap", mapId: currentMapId });
  });

  document.getElementById("lang").addEventListener("change", () => {
    updateMenuLanguage();
    renderLobby();
    renderResumeCards();
  });

  onNetworkMessage(handleNetworkMessage);

  updateMenuLanguage();
  renderLobby();
  renderResumeCards();
}

function updateMenuLanguage() {
  menuTitle.textContent = t("menuTitle");
  nickname.placeholder = t("nickname");
  createRoomBtn.textContent = t("createRoom");
  joinRoomBtn.textContent = t("join");
  roomCodeInput.placeholder = t("roomCodePlaceholder");
}