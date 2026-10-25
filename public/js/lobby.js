import { onNetworkMessage, sendMessage } from "./network.js";
import { t } from "./i18n.js";
import { MAPS, getMapById } from "./maps.js";

// ---------- Локальное состояние лобби ----------

let myPlayerId = null;
let myRoomCode = null;
let myGuestId = null;
let mySpectatorId = null;
let isHost = false;
let resumeLobby = false;
let myReady = false;
let lastUpdate = null;
let onGameStartCb = null;

const pendingSpectatorCards = new Map();

const RESUME_KEY = "resumeCards";

const PREVIEW_COLORS = {
  ".": "#7bb546",
  F: "#4e8f3a",
  H: "#b0a06a",
  W: "#3d85c8",
  M: "#8d8d8d",
  C: "#e8e8f0",
  V: "#e8e8f0",
  1: "#4a90d9", 2: "#e5484d", 3: "#46a758", 4: "#e8a33d",
  a: "#4a90d9", b: "#e5484d", c: "#46a758", d: "#e8a33d"
};

function el(id) {
  return document.getElementById(id);
}

function isSpectator() {
  return mySpectatorId !== null && myPlayerId === null;
}

// ---------- Карточки резюма ----------

export function upsertResumeCard(code, playerId, token) {
  if (!code) return;
  const cards = readResumeCards();
  cards[code] = { code, playerId, token, at: Date.now() };
  localStorage.setItem(RESUME_KEY, JSON.stringify(cards));
  renderResumeCards();
}

export function removeResumeCard(code) {
  const cards = readResumeCards();
  delete cards[code];
  localStorage.setItem(RESUME_KEY, JSON.stringify(cards));
  renderResumeCards();
}

function readResumeCards() {
  try {
    return JSON.parse(localStorage.getItem(RESUME_KEY)) || {};
  } catch {
    return {};
  }
}

function renderResumeCards() {
  const box = el("resumeCards");
  if (!box) return;
  box.innerHTML = "";

  const cards = Object.values(readResumeCards())
    .sort((a, b) => (b.at || 0) - (a.at || 0));

  for (const card of cards) {
    const row = document.createElement("div");
    row.className = "resumeCard";

    const btn = document.createElement("button");
    btn.className = "resumeCardButton";
    btn.textContent = `${t("resumeCard")}: ${card.code}`;
    btn.addEventListener("click", () => {
      sendMessage({
        type: "resumeGame",
        roomCode: card.code,
        token: card.token,
        name: (el("nickname").value || "").trim() || t("defaultName")
      });
    });

    const del = document.createElement("button");
    del.className = "resumeCardDelete";
    del.textContent = "✕";
    del.addEventListener("click", () => removeResumeCard(card.code));

    row.appendChild(btn);
    row.appendChild(del);
    box.appendChild(row);
  }
}

// ---------- Превью карты ----------

function drawMapPreview(mapId) {
  const canvas = el("mapPreview");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const mapDef = getMapById(mapId);
  const size = mapDef.rows.length;
  const cell = canvas.width / size;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ch = mapDef.rows[y][x];
      ctx.fillStyle = PREVIEW_COLORS[ch] || PREVIEW_COLORS["."];
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
}

// ---------- Информационные карточки наблюдателей ----------

function addSpectatorInfo(message) {
  const box = el("lobbyRequests");
  if (!box || pendingSpectatorCards.has(message.spectatorId)) return;

  const card = document.createElement("div");
  card.className = "guestRequestCard";

  const title = document.createElement("div");
  title.textContent = `${message.name} — ${t("spectatorJoined")}`;
  card.appendChild(title);

  box.appendChild(card);
  pendingSpectatorCards.set(message.spectatorId, card);
}

function pruneSpectatorCards() {
  const update = lastUpdate || {};
  for (const [id, card] of Array.from(pendingSpectatorCards)) {
    const still = (update.spectators || []).some(s => s.id === id);
    if (!still) {
      card.remove();
      pendingSpectatorCards.delete(id);
    }
  }
}

function clearSpectatorCards() {
  for (const card of pendingSpectatorCards.values()) card.remove();
  pendingSpectatorCards.clear();
}

// ---------- Рендер лобби ----------

function renderLobby() {
  const update = lastUpdate || {};

  el("roomCodeDisplay").textContent = `${t("roomCode")}: ${myRoomCode || ""}`;

  const mapDef = getMapById(update.mapId || "classic");
  const maxSeats = Math.min(4, mapDef.players[mapDef.players.length - 1]);

  const list = el("playerList");
  list.innerHTML = "";

  if (resumeLobby) {
    renderSeatDraft(update);
  } else {
    // Места карты: человек / селект хоста / бот / пусто
    for (let seatId = 1; seatId <= maxSeats; seatId++) {
      const human = (update.players || []).find(p => p.id === seatId);
      const bot = (update.bots || []).find(b => b.id === seatId);
      const li = document.createElement("li");

      const label = document.createElement("span");
      label.textContent = `${t("seatLabel")} ${seatId}: `;
      li.appendChild(label);

      if (human) {
        const span = document.createElement("span");
        const mark = human.id === myPlayerId ? ` ${t("you")}` : "";
        span.textContent = `${human.name}${mark} — ` +
          (human.ready ? t("readyMark") : t("notReadyMark"));
        li.appendChild(span);
      } else if (isHost) {
        const select = document.createElement("select");

        const opts = [{ value: "none", text: t("seatNone") }];
        opts.push({ value: "bot:balanced", text: t("botBalanced") });
        opts.push({ value: "bot:aggressive", text: t("botAggressive") });
        for (const spec of update.spectators || []) {
          opts.push({
            value: `spectator:${spec.id}`,
            text: `${t("spectator")}: ${spec.name}`
          });
        }

        for (const o of opts) {
          const op = document.createElement("option");
          op.value = o.value;
          op.textContent = o.text;
          select.appendChild(op);
        }

        select.value = bot ? `bot:${bot.personality || "balanced"}` : "none";

        select.addEventListener("change", () => {
          const [kind, arg] = select.value.split(":");
          sendMessage({
            type: "setLobbySeat",
            seatId,
            kind,
            personality: kind === "bot" ? arg : null,
            spectatorId: kind === "spectator" ? Number(arg) : null
          });
        });

        li.appendChild(select);
      } else if (bot) {
        const span = document.createElement("span");
        span.textContent = bot.personality === "aggressive"
          ? t("botAggressive")
          : t("botBalanced");
        li.appendChild(span);
      } else {
        const span = document.createElement("span");
        span.textContent = t("seatNone");
        li.appendChild(span);
      }

      list.appendChild(li);
    }

    // Наблюдатели отдельным списком
    for (const spec of update.spectators || []) {
      const li = document.createElement("li");
      const mark = spec.id === mySpectatorId ? ` ${t("you")}` : "";
      li.textContent = `${t("spectator")}: ${spec.name}${mark}`;
      list.appendChild(li);
    }
  }

  pruneSpectatorCards();

  // Карта
  const mapSelect = el("mapSelect");
  if (mapSelect && mapSelect.dataset.filled !== "1") {
    mapSelect.innerHTML = "";
    for (const map of MAPS) {
      const option = document.createElement("option");
      option.value = map.id;
      option.textContent = `${t(map.nameKey)} (${map.rows.length}×${map.rows.length})`;
      mapSelect.appendChild(option);
    }
    mapSelect.dataset.filled = "1";
    mapSelect.addEventListener("change", () => {
      sendMessage({ type: "setMap", mapId: mapSelect.value });
    });
  }
  if (mapSelect) mapSelect.value = update.mapId || "classic";
  mapSelect.disabled = !isHost || resumeLobby;

  el("mapInfo").textContent =
    `${t(mapDef.nameKey)} · ${t("playersLabel")}: ${mapDef.players.join(", ")}`;
  drawMapPreview(mapDef.id);

  // Готовность / старт / наблюдатель
  const readyBtn = el("readyBtn");
  const startBtn = el("startBtn");

  if (isSpectator()) {
    readyBtn.style.display = "none";
    startBtn.style.display = "none";
    el("lobbyStatus").textContent = t("spectatorHint");
    return;
  }

  el("lobbyStatus").textContent = "";

  if (resumeLobby) {
    readyBtn.style.display = "none";
    startBtn.style.display = isHost ? "" : "none";
    startBtn.disabled = !isHost;
    return;
  }

  readyBtn.style.display = "";
  startBtn.style.display = isHost ? "" : "none";
  readyBtn.textContent = myReady ? t("ready") : t("notReady");
  readyBtn.classList.toggle("readyOn", myReady);

  const seatsCount = (update.players || []).length + (update.bots || []).length;
  const allReady = (update.players || []).length > 0 &&
    (update.players || []).every(p => p.ready);
  startBtn.disabled = !(
    isHost &&
    mapDef.players.includes(seatsCount) &&
    allReady
  );
}

function renderSeatDraft(update) {
  const list = el("playerList");
  const draft = update.seatDraft || {};
  const guests = update.guests || [];

  for (const key of Object.keys(draft).sort((a, b) => Number(a) - Number(b))) {
    const seatId = Number(key);
    const d = draft[key];
    const li = document.createElement("li");

    const label = document.createElement("span");
    label.textContent = `${t("seatLabel")} ${seatId}: `;
    li.appendChild(label);

    if (seatId === 1 || !isHost) {
      const kindText = d.kind === "bot"
        ? t("seatBot")
        : d.kind === "passive"
          ? t("seatPassive")
          : d.kind === "eliminate"
            ? t("seatEliminated")
            : t("seatHuman");
      const span = document.createElement("span");
      span.textContent = kindText;
      li.appendChild(span);
      list.appendChild(li);
      continue;
    }

    const select = document.createElement("select");

    const options = [
      { value: "passive", text: t("seatPassive") },
      { value: "bot:balanced", text: t("botBalanced") },
      { value: "bot:aggressive", text: t("botAggressive") },
      { value: "eliminate", text: t("seatEliminated") }
    ];
    for (const guest of guests) {
      options.push({ value: `human:${guest.guestId}`, text: guest.name });
    }

    for (const opt of options) {
      const option = document.createElement("option");
      option.value = opt.value;
      option.textContent = opt.text;
      select.appendChild(option);
    }

    const current = d.kind === "bot"
      ? `bot:${d.personality || "balanced"}`
      : d.kind === "human"
        ? `human:${d.guestId}`
        : d.kind;
    select.value = current;

    select.addEventListener("change", () => {
      const [kind, arg] = select.value.split(":");
      sendMessage({
        type: "setSeat",
        seatId,
        kind,
        guestId: kind === "human" ? Number(arg) : null,
        personality: kind === "bot" ? arg : null
      });
    });

    li.appendChild(select);
    list.appendChild(li);
  }
}

// ---------- Сеть ----------

function handleMessage(message) {
  if (message.type === "roomCreated") {
    myRoomCode = message.roomCode;
    myPlayerId = message.playerId;
    myGuestId = null;
    mySpectatorId = null;
    isHost = true;
    resumeLobby = false;
    myReady = false;
    showLobby();
    return;
  }

  if (message.type === "roomJoined") {
    myRoomCode = message.roomCode;
    myPlayerId = message.playerId;
    myGuestId = message.guestId || null;
    mySpectatorId = message.spectatorId || null;
    isHost = message.playerId === 1;
    resumeLobby = !!message.resumeLobby;
    myReady = !!message.resumeLobby;
    showLobby();
    return;
  }

  if (message.type === "roomUpdate") {
    lastUpdate = message;
    renderLobby();
    return;
  }

  if (message.type === "spectatorJoined") {
    if (isHost) addSpectatorInfo(message);
    return;
  }

  if (message.type === "waitingApproval") {
    el("lobbyStatus").textContent = t("waitingApproval");
    return;
  }

  if (message.type === "guestRequestDenied") {
    backToMenu(t("guestDenied"));
    return;
  }

  if (message.type === "resumeStartedWithoutYou") {
    backToMenu(t("resumeWithoutYou"));
    return;
  }

  if (message.type === "roomClosed") {
    backToMenu(message.code === "hostLeft" ? t("hostLeftRoom") : t("roomClosed"));
    return;
  }

  if (message.type === "error") {
    const text = t(message.code) || message.code;
    const menuVisible = !el("menuScreen").classList.contains("hidden");
    if (menuVisible) el("menuStatus").textContent = text;
    else el("lobbyStatus").textContent = text;
    return;
  }

  if (message.type === "gameStart") {
    clearSpectatorCards();
    if (onGameStartCb) onGameStartCb(message);
    return;
  }
}

function showLobby() {
  el("menuScreen").classList.add("hidden");
  el("lobbyScreen").classList.remove("hidden");
  el("gameScreen").classList.add("hidden");
  el("lobbyStatus").textContent = "";
  renderLobby();
}

function backToMenu(text) {
  myPlayerId = null;
  myRoomCode = null;
  myGuestId = null;
  mySpectatorId = null;
  isHost = false;
  resumeLobby = false;
  lastUpdate = null;
  clearSpectatorCards();

  el("lobbyScreen").classList.add("hidden");
  el("gameScreen").classList.add("hidden");
  el("menuScreen").classList.remove("hidden");
  if (text) el("menuStatus").textContent = text;
  renderResumeCards();
}

// ---------- Инициализация ----------

export function initLobby(callbacks) {
  onGameStartCb = callbacks.onGameStart;

  onNetworkMessage(handleMessage);

  el("createRoomBtn").addEventListener("click", () => {
    const name = (el("nickname").value || "").trim() || t("defaultName");
    sendMessage({ type: "createRoom", name });
  });

  el("joinRoomBtn").addEventListener("click", () => {
    const code = (el("roomCodeInput").value || "").trim().toUpperCase();
    const name = (el("nickname").value || "").trim() || t("defaultName");
    if (!code) {
      el("menuStatus").textContent = t("enterCode");
      return;
    }
    sendMessage({ type: "joinRoom", roomCode: code, name });
  });

  el("readyBtn").addEventListener("click", () => {
    myReady = !myReady;
    sendMessage({ type: "setReady", ready: myReady });
    renderLobby();
  });

  el("startBtn").addEventListener("click", () => {
    sendMessage({ type: "startGame" });
  });

  el("leaveRoomBtn").addEventListener("click", () => {
    sendMessage({ type: "leaveRoom" });
    backToMenu("");
  });

  renderResumeCards();
}

export function getMyPlayerId() {
  return myPlayerId;
}

export function getRoomCode() {
  return myRoomCode;
}