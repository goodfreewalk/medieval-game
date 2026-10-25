import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import express from "express";
import { WebSocketServer } from "ws";

import { state, initGame } from "../public/js/state.js";
import { TERRAIN } from "../public/js/terrain.js";
import { getMapById } from "../public/js/maps.js";
import { BUILD } from "../public/js/build.js";
import { computeChecksum } from "../public/js/checksum.js";
import {
  applyMove,
  applyAttack,
  applyRecruit,
  applyEndTurn,
  eliminatePlayer,
  calculateDamage
} from "../public/js/logic.js";
import { planBotAction } from "./bots.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 4;
const MAX_SPECTATORS = 4;

const SAVES_DIR = path.join(__dirname, "..", "saves");
const SAVE_VERSION = 2;
const SAVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
fs.mkdirSync(SAVES_DIR, { recursive: true });

const AUTO_TURN_DELAY_MS = 4000;
const BOT_FIRST_STEP_MS = 900;
const BOT_STEP_DELAY_MS = 500;
const BOT_MAX_STEPS = 40;
const RECONNECT_GRACE_MS = 60000;
const STATE_FALLBACK_MS = 3000;

const REL_MIN = -100;
const REL_MAX = 100;
const REL_DECAY = 0.97;
const REL_PARDON = 2;
const PARDON_PROX = 3;

const ROOM_CODE_RE = /^[A-Z0-9]{4}$/;

function safeCode(raw) {
  const code = String(raw || "").toUpperCase();
  return ROOM_CODE_RE.test(code) ? code : null;
}

// Вместимость текущей карты комнаты (максимум мест)
function mapMaxSeats(room) {
  const def = getMapById(room.mapId);
  const arr = def && Array.isArray(def.players) && def.players.length
    ? def.players
    : [2];
  return Math.min(MAX_PLAYERS, arr[arr.length - 1]);
}

const app = express();

app.use(
  express.static(path.join(__dirname, "..", "public"), {
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
    }
  })
);

const httpServer = app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT} (build ${BUILD})`);
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: 64 * 1024 });
console.log("WebSocket готов");

const rooms = new Map();

// ---------- Сохранения ----------

function savePath(code) {
  return path.join(SAVES_DIR, `${code}.json`);
}

function cleanOldSaves() {
  let files = [];
  try { files = fs.readdirSync(SAVES_DIR); } catch { return; }
  const now = Date.now();
  for (const file of files) {
    const full = path.join(SAVES_DIR, file);
    try {
      const save = JSON.parse(fs.readFileSync(full, "utf8"));
      if (!save || now - (save.savedAt || 0) > SAVE_TTL_MS) fs.unlinkSync(full);
    } catch {
      try { fs.unlinkSync(full); } catch {}
    }
  }
}
cleanOldSaves();

function readSave(code) {
  try {
    const save = JSON.parse(fs.readFileSync(savePath(code), "utf8"));
    if (!save || save.version !== SAVE_VERSION) return { error: "saveIncompatible" };
    if (Date.now() - (save.savedAt || 0) > SAVE_TTL_MS) {
      try { fs.unlinkSync(savePath(code)); } catch {}
      return { error: "saveNotFound" };
    }
    return { save };
  } catch {
    return { error: "saveNotFound" };
  }
}

// ---------- Зеркало состояния ----------

function loadMirror(room) {
  const m = room.mirror;
  state.map = m.map;
  state.units = m.units;
  state.owners = new Map(m.owners);
  state.players = m.players;
  state.currentPlayer = m.currentPlayer;
  state.eliminated = new Set(m.eliminated);
  state.seatKinds = m.seatKinds;
  state.gameOver = m.gameOver;
  state.winner = m.winner;
}

function saveMirror(room) {
  room.mirror = {
    map: state.map,
    units: state.units,
    owners: Array.from(state.owners.entries()),
    players: state.players,
    currentPlayer: state.currentPlayer,
    eliminated: Array.from(state.eliminated),
    seatKinds: state.seatKinds,
    gameOver: state.gameOver,
    winner: state.winner
  };
}

// ---------- Контрольные суммы (защита от рассинхрона) ----------

// После каждой смены хода рассылаем сумму серверного зеркала:
// клиент сверяет со своей и при расхождении молча тянет fullState из зеркала
function sendTurnChecksum(room) {
  if (!room.mirror) return;
  loadMirror(room);
  const checksum = computeChecksum(state);
  broadcastToRoom(room, { type: "turnChecksum", checksum });
}

// ---------- Отношения ----------

function initRelations(room) {
  room.relations = {};
  for (const seat of room.seats) room.relations[seat.id] = {};
  room.lastTurnAttacked = new Set();
}

function normalizeRelations(room) {
  if (!room.relations) room.relations = {};
  const live = new Set(room.seats.map(s => s.id));
  for (const a of Object.keys(room.relations)) {
    if (!live.has(Number(a))) { delete room.relations[a]; continue; }
    for (const b of Object.keys(room.relations[a])) {
      if (!live.has(Number(b))) delete room.relations[a][b];
    }
  }
  for (const id of live) if (!room.relations[id]) room.relations[id] = {};
  if (!room.lastTurnAttacked) room.lastTurnAttacked = new Set();
}

function pruneRelations(room, id) {
  if (room.relations) {
    delete room.relations[id];
    for (const a of Object.keys(room.relations)) delete room.relations[a][id];
  }
  if (room.lastTurnAttacked) room.lastTurnAttacked.delete(id);
}

function bumpRelation(room, a, b, delta) {
  if (!room.relations[a]) room.relations[a] = {};
  const v = (room.relations[a][b] || 0) + delta;
  room.relations[a][b] = Math.max(REL_MIN, Math.min(REL_MAX, Math.round(v)));
}

function decayRelations(room) {
  if (!room.relations) return;
  for (const a of Object.keys(room.relations)) {
    for (const b of Object.keys(room.relations[a])) {
      let v = room.relations[a][b] * REL_DECAY;
      if (Math.abs(v) < 1) v = 0;
      room.relations[a][b] = Math.round(v);
    }
  }
}

function recordAttackEvent(room, attacker, defender, damage, killed) {
  if (!attacker || !defender || attacker === defender) return;
  const delta = 4 + Math.round(damage / 8) + (killed ? 12 : 0);
  bumpRelation(room, defender, attacker, -delta);
  room.lastTurnAttacked.add(defender);
}

function recordCaptureEvent(room, newOwner, oldOwner) {
  if (!newOwner || !oldOwner || newOwner === oldOwner) return;
  bumpRelation(room, oldOwner, newOwner, -20);
  room.lastTurnAttacked.add(oldOwner);
}

function applyPardon(room, me) {
  if (!room.relations) return;

  const myUnits = state.units.filter(u => u.owner === me);
  if (myUnits.length === 0) return;

  const size = state.map.length;
  for (const seat of room.seats) {
    const other = seat.id;
    if (other === me || room.lastTurnAttacked.has(other)) continue;

    let prox = false;
    outer:
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const t = state.map[y][x];
        if (t !== TERRAIN.CASTLE && t !== TERRAIN.VILLAGE) continue;
        if (state.owners.get(`${x},${y}`) !== other) continue;
        for (const u of myUnits) {
          if (Math.abs(u.x - x) + Math.abs(u.y - y) <= PARDON_PROX) {
            prox = true; break outer;
          }
        }
      }
    }
    if (prox) bumpRelation(room, other, me, REL_PARDON);
  }
}

function snapshotBuildingOwners() {
  const map = new Map();
  const size = state.map.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = state.map[y][x];
      if (t === TERRAIN.CASTLE || t === TERRAIN.VILLAGE) {
        map.set(`${x},${y}`, state.owners.get(`${x},${y}`) || 0);
      }
    }
  }
  return map;
}

function applyActionWithRelations(room, action, meId) {
  loadMirror(room);

  let before = null;
  let atkInfo = null;

  if (action.kind === "attack") {
    const a = state.units.find(u => u.id === action.attackerId);
    const d = state.units.find(u => u.id === action.targetId);
    if (a && d && a.owner !== d.owner) {
      const dmg = calculateDamage(a, d);
      atkInfo = { attacker: a.owner, defender: d.owner, damage: dmg, killed: dmg >= d.hp };
    }
  }
  if (action.kind === "move" || action.kind === "attack") {
    before = snapshotBuildingOwners();
  }

  if (action.kind === "move") applyMove(action.unitId, action.x, action.y);
  else if (action.kind === "attack") applyAttack(action.attackerId, action.targetId);
  else if (action.kind === "recruit") applyRecruit(action.type, action.x, action.y);
  else if (action.kind === "endTurn") applyEndTurn();

  if (before) {
    for (const [key, oldOwner] of before) {
      const newOwner = state.owners.get(key) || 0;
      if (oldOwner !== 0 && newOwner !== 0 && oldOwner !== newOwner) {
        recordCaptureEvent(room, newOwner, oldOwner);
      }
    }
  }
  if (atkInfo) {
    recordAttackEvent(room, atkInfo.attacker, atkInfo.defender, atkInfo.damage, atkInfo.killed);
  }
  if (action.kind === "endTurn") {
    applyPardon(room, meId);
    room.lastTurnAttacked = new Set();
    decayRelations(room);
  }

  saveMirror(room);
}

function sendRelations(room) {
  broadcastToRoom(room, { type: "relationsUpdate", relations: room.relations || {} });
}

// ---------- Вспомогательные ----------

function getRoom(ws) {
  if (!ws.roomCode) return null;
  return rooms.get(ws.roomCode) || null;
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateRoomCode() : code;
}

function broadcastToRoom(room, message) {
  const text = JSON.stringify(message);
  const targets = [...room.players, ...(room.spectators || [])];
  for (const slot of targets) {
    try {
      if (slot.ws && slot.ws.readyState === 1) slot.ws.send(text);
    } catch (error) {
      console.error("Не удалось отправить сообщение:", error.message);
    }
  }
}

function sendTo(ws, message) {
  try {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
  } catch (error) {
    console.error("Не удалось отправить сообщение:", error.message);
  }
}

function sendRoomUpdate(room) {
  broadcastToRoom(room, {
    type: "roomUpdate",
    mapId: room.mapId,
    resumeLobby: !!room.resumeLobby,
    seatDraft: room.seatDraft || null,
    bots: room.lobbyBots || null,
    spectators: (room.spectators || []).map(s => ({ id: s.id, name: s.name })),
    saveInfo: room.saveData
      ? { seats: room.saveData.players, turn: room.saveData.turn }
      : null,
    guests: (room.guests || []).map(g => ({ guestId: g.guestId, name: g.name, requestedSeat: g.requestedSeat })),
    players: room.players.map(player => ({ id: player.id, name: player.name, ready: player.ready }))
  });
}

function nextSeat(room, fromId) {
  const ids = (room.seats || []).map(s => s.id).sort((a, b) => a - b);
  if (ids.length === 0) return fromId;
  const index = ids.indexOf(fromId);
  const start = index === -1 ? 0 : index + 1;
  return ids[start % ids.length];
}

function seatKind(room, id) {
  const seat = (room.seats || []).find(s => s.id === id);
  return seat ? seat.kind : null;
}

// ---------- Драйвер автоматических мест ----------

function armTurnDriver(room) {
  clearTimeout(room.autoTimer);
  room.autoTimer = null;
  if (room.phase !== "game" || !room.mirror) return;

  const kind = seatKind(room, room.turn);

  if (kind === "passive") {
    room.autoTimer = setTimeout(() => {
      if (room.phase !== "game" || seatKind(room, room.turn) !== "passive") return;
      const me = room.turn;
      const action = { kind: "endTurn" };
      applyActionWithRelations(room, action, me);
      action.next = room.mirror.currentPlayer;
      broadcastToRoom(room, { type: "gameAction", action });
      room.turn = action.next;
      sendRelations(room);
      sendTurnChecksum(room);
      armTurnDriver(room);
    }, AUTO_TURN_DELAY_MS);
    return;
  }

  if (kind === "bot") {
    room.botSteps = 0;
    room.botTargetUsage = new Map();
    room.autoTimer = setTimeout(() => botStep(room), BOT_FIRST_STEP_MS);
  }
}

function botStep(room) {
  if (room.phase !== "game" || !room.mirror) return;
  if (seatKind(room, room.turn) !== "bot") return;

  const me = room.turn;

  try {
    loadMirror(room);

    if (state.gameOver || state.currentPlayer !== me) {
      saveMirror(room);
      return;
    }

    const seat = room.seats.find(s => s.id === me);
    const ctx = {
      me,
      relations: (room.relations && room.relations[me]) || {},
      usage: room.botTargetUsage || new Map(),
      defense: false
    };

    const action = room.botSteps < BOT_MAX_STEPS
      ? planBotAction(state, seat.personality || "balanced", ctx)
      : null;

    if (action) {
      room.botSteps += 1;
      applyActionWithRelations(room, action, me);
      broadcastToRoom(room, { type: "gameAction", action });
      room.autoTimer = setTimeout(() => botStep(room), BOT_STEP_DELAY_MS);
      return;
    }

    const endAction = { kind: "endTurn" };
    applyActionWithRelations(room, endAction, me);
    endAction.next = room.mirror.currentPlayer;
    broadcastToRoom(room, { type: "gameAction", action: endAction });
    room.turn = endAction.next;
    sendRelations(room);
    sendTurnChecksum(room);
    armTurnDriver(room);
  } catch (error) {
    console.error(`[bot] место ${me} упало в планере:`, (error && error.stack) || error);
    try {
      const endAction = { kind: "endTurn" };
      applyActionWithRelations(room, endAction, me);
      endAction.next = room.mirror ? room.mirror.currentPlayer : nextSeat(room, me);
      broadcastToRoom(room, { type: "gameAction", action: endAction });
      room.turn = endAction.next;
      sendTurnChecksum(room);
      armTurnDriver(room);
    } catch (fatal) {
      console.error(`[bot] место ${me}: не удалось завершить ход:`, (fatal && fatal.stack) || fatal);
    }
  }
}

// ---------- Резерв синхронизации ----------

function armStateFallback(room, targetId, code) {
  setTimeout(() => {
    if (room.pendingStateFor !== targetId) return;
    room.pendingStateFor = undefined;

    const slot = room.players.find(p => p.id === targetId);
    if (!slot || !slot.ws || slot.ws.readyState !== 1) return;

    let fallback = room.mirror || null;
    if (!fallback && room.saveData) fallback = room.saveData.state;
    if (!fallback) {
      const { save } = readSave(code);
      if (save) fallback = save.state;
    }

    if (fallback) {
      slot.hasState = true;
      sendTo(slot.ws, { type: "fullState", state: fallback });
      sendRelations(room);
      console.log(`Состояние для места ${targetId} восстановлено из резерва`);
    } else {
      const wsTarget = slot.ws;
      slot.disconnected = true;
      slot.ws = null;
      slot.hasState = false;
      sendTo(wsTarget, { type: "gameGone" });
      console.log(`Состояние для места ${targetId} потеряно: слот освобождён`);
    }
  }, STATE_FALLBACK_MS);
}

// ---------- Устранения ----------

function eliminateSeat(room, code, playerId) {
  const slot = room.players.find(p => p.id === playerId);
  if (slot) clearTimeout(slot.disconnectTimer);
  clearTimeout(room.autoTimer);

  room.players = room.players.filter(p => p.id !== playerId);
  room.seats = (room.seats || []).filter(s => s.id !== playerId);
  pruneRelations(room, playerId);

  if (room.turn === playerId || !room.seats.some(s => s.id === room.turn)) {
    room.turn = nextSeat(room, playerId);
  }

  if (room.mirror) {
    loadMirror(room);
    eliminatePlayer(playerId, room.turn);
    saveMirror(room);
  }

  broadcastToRoom(room, { type: "playerEliminated", playerId, nextTurn: room.turn });
  sendRelations(room);
  sendTurnChecksum(room);
  armTurnDriver(room);

  if (room.players.length === 0 && (room.guests || []).length === 0 && (room.spectators || []).length === 0) {
    rooms.delete(code);
    console.log(`Комната ${code} пуста после устранения`);
  } else {
    console.log(`Игрок ${playerId} устранён в комнате ${code}, ход: ${room.turn}`);
  }
}

// ---------- Heartbeat ----------

const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on("close", () => clearInterval(heartbeatInterval));
wss.on("error", (error) => console.error("Ошибка WebSocket-сервера:", error));

wss.on("connection", (ws) => {
  console.log("Игрок подключился");
  ws.roomCode = null;
  ws.playerId = null;
  ws.guestId = null;
  ws.spectatorId = null;
  ws.isAlive = true;

  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("error", (error) => console.error("Ошибка соединения игрока:", error.message));

  ws.on("message", (data) => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }

    // ---------- Версионный гейт на точках входа ----------
    // Старая вкладка держит старый штамп build.js в памяти и не сможет
    // создать/войти/возобновить комнату: получит понятную ошибку
    if (
      (message.type === "createRoom" || message.type === "joinRoom" || message.type === "resumeGame") &&
      message.build !== BUILD
    ) {
      sendTo(ws, { type: "error", code: "clientOutdated" });
      return;
    }

    // ---------- Создание комнаты ----------
    if (message.type === "createRoom") {
      const code = generateRoomCode();
      const room = {
        players: [],
        guests: [],
        spectators: [],
        lobbyBots: [],
        phase: "lobby",
        resumeLobby: false,
        turn: 1,
        mapId: "classic",
        nextGuestId: 1,
        nextSpectatorId: 1,
        relations: {},
        lastTurnAttacked: new Set()
      };
      rooms.set(code, room);

      room.players.push({
        ws, id: 1,
        name: String(message.name || "Игрок 1").slice(0, 24),
        ready: false, hasState: false
      });

      ws.roomCode = code;
      ws.playerId = 1;

      sendTo(ws, { type: "roomCreated", roomCode: code, playerId: 1, mapId: room.mapId });
      sendRoomUpdate(room);
      console.log(`Создана комната ${code}`);
      return;
    }

    // ---------- Назначение места хостом (селект в лобби) ----------
    if (message.type === "setLobbySeat") {
      const room = getRoom(ws);
      if (!room || room.phase !== "lobby" || room.resumeLobby || ws.playerId !== 1) return;
      const seatId = message.seatId;
      const maxSeats = mapMaxSeats(room);
      if (!Number.isInteger(seatId) || seatId < 2 || seatId > maxSeats) return;
      if (room.players.some(p => p.id === seatId)) return; // место занято человеком

      const kind = message.kind; // "bot" | "spectator" | "none"
      room.lobbyBots = room.lobbyBots.filter(b => b.id !== seatId);

      if (kind === "bot") {
        const personality = message.personality === "aggressive" ? "aggressive" : "balanced";
        room.lobbyBots.push({ id: seatId, personality });
      } else if (kind === "spectator") {
        const spec = (room.spectators || []).find(s => s.id === message.spectatorId);
        if (!spec) return;
        room.spectators = room.spectators.filter(s => s !== spec);
        room.players.push({ ws: spec.ws, id: seatId, name: spec.name, ready: false, hasState: false });
        spec.ws.playerId = seatId;
        spec.ws.spectatorId = null;
        sendTo(spec.ws, { type: "roomJoined", roomCode: spec.ws.roomCode, playerId: seatId, mapId: room.mapId });
      }

      sendRoomUpdate(room);
      console.log(`Место ${seatId} в комнате ${ws.roomCode}: ${kind}`);
      return;
    }

    // ---------- Сохранение партии ----------
    if (message.type === "saveGame") {
      const room = getRoom(ws);
      if (!room || room.phase !== "game" || ws.playerId !== 1) return;

      const token = crypto.randomBytes(8).toString("hex");
      const save = {
        version: SAVE_VERSION,
        savedAt: Date.now(),
        mapId: room.mapId,
        turn: room.turn,
        players: (room.seats || []).map(s => {
          const human = room.players.find(p => p.id === s.id);
          return { id: s.id, kind: s.kind, personality: s.personality || null, name: human ? human.name : null };
        }),
        state: room.mirror || message.state,
        relations: room.relations || {},
        token
      };

      try {
        fs.writeFileSync(savePath(ws.roomCode), JSON.stringify(save));
        sendTo(ws, { type: "saveOk", token });
        console.log(`Игра сохранена: комната ${ws.roomCode}`);
      } catch (error) {
        console.error("Не удалось сохранить игру:", error.message);
      }
      return;
    }

    // ---------- Возобновление ----------
    if (message.type === "resumeGame") {
      const code = safeCode(message.roomCode);
      if (!code) { sendTo(ws, { type: "error", code: "roomNotFound" }); return; }

      if (rooms.has(code)) {
        const existing = rooms.get(code);
        const statefulConnected = existing.players.some(p => !p.disconnected && p.hasState);

        if (!statefulConnected) {
          clearTimeout(existing.autoTimer);
          for (const p of existing.players) clearTimeout(p.disconnectTimer);
          for (const guest of existing.guests || []) sendTo(guest.ws, { type: "roomClosed", code: "hostLeft" });
          rooms.delete(code);
        } else {
          const slot = existing.players.find(p => p.id === 1);
          if (slot && slot.disconnected) {
            slot.ws = ws;
            slot.disconnected = false;
            slot.hasState = false;
            clearTimeout(slot.disconnectTimer);
            slot.disconnectTimer = null;
            ws.roomCode = code;
            ws.playerId = 1;

            sendTo(ws, { type: "rejoinOk", playerId: 1, roomCode: code });
            for (const player of existing.players) {
              if (player.id !== 1) sendTo(player.ws, { type: "opponentReconnected", playerId: 1 });
            }
            existing.pendingStateFor = 1;
            for (const player of existing.players) {
              if (player.id !== 1) sendTo(player.ws, { type: "requestState" });
            }
            armStateFallback(existing, 1, code);
            sendRelations(existing);
            return;
          }
          sendTo(ws, { type: "error", code: "gameInProgress" });
          return;
        }
      }

      const { save, error } = readSave(code);
      if (error) { sendTo(ws, { type: "error", code: error }); return; }
      if (!save.token || save.token !== message.token) {
        sendTo(ws, { type: "error", code: "resumeNotHost" });
        return;
      }

      const room = {
        players: [],
        guests: [],
        spectators: [],
        lobbyBots: [],
        phase: "lobby",
        resumeLobby: true,
        saveData: save,
        mapId: save.mapId,
        turn: save.turn,
        nextGuestId: 1,
        nextSpectatorId: 1,
        seatDraft: {},
        relations: save.relations || {},
        lastTurnAttacked: new Set()
      };

      for (const seat of save.players) {
        if (seat.id === 1) {
          room.seatDraft[seat.id] = { kind: "human", guestId: null };
        } else if (seat.kind === "bot") {
          room.seatDraft[seat.id] = { kind: "bot", personality: seat.personality || "balanced", guestId: null };
        } else {
          room.seatDraft[seat.id] = { kind: "passive", guestId: null };
        }
      }

      rooms.set(code, room);
      room.players.push({ ws, id: 1, name: String(message.name || "Игрок 1").slice(0, 24), ready: true, hasState: false });
      ws.roomCode = code;
      ws.playerId = 1;

      sendTo(ws, { type: "roomJoined", roomCode: code, playerId: 1, mapId: room.mapId, resumeLobby: true });
      sendRoomUpdate(room);
      console.log(`Комната ${code} возобновлена из сохранения`);
      return;
    }

    // ---------- Вход в комнату ----------
    if (message.type === "joinRoom") {
      const code = safeCode(message.roomCode);
      const room = code ? rooms.get(code) : null;
      if (!room) {
        const { save } = readSave(code || "");
        sendTo(ws, { type: "error", code: save ? "resumeNotOpened" : "roomNotFound" });
        return;
      }

      const name = String(message.name || "Игрок").slice(0, 24);

      if (room.phase === "game") {
        const wanted = message.preferredSeat;
        const seat = (room.seats || []).find(s => s.id === wanted);

        if (seat && seat.kind === "human") {
          const slot = room.players.find(p => p.id === wanted);
          if (slot && slot.disconnected) {
            slot.ws = ws;
            slot.disconnected = false;
            slot.hasState = false;
            clearTimeout(slot.disconnectTimer);
            slot.disconnectTimer = null;
            ws.roomCode = code;
            ws.playerId = wanted;

            sendTo(ws, { type: "rejoinOk", playerId: wanted, roomCode: code });
            for (const player of room.players) {
              if (player.id !== wanted) sendTo(player.ws, { type: "opponentReconnected", playerId: wanted });
            }
            room.pendingStateFor = wanted;
            for (const player of room.players) {
              if (player.id !== wanted) sendTo(player.ws, { type: "requestState" });
            }
            armStateFallback(room, wanted, code);
            sendRelations(room);
            return;
          }
          sendTo(ws, { type: "error", code: "roomFull" });
          return;
        }

        if (seat && seat.kind === "passive") {
          const guestId = room.nextGuestId++;
          room.guests.push({ ws, guestId, name, requestedSeat: wanted });
          ws.roomCode = code;
          ws.guestId = guestId;
          sendTo(ws, { type: "waitingApproval" });
          const host = room.players.find(p => p.id === 1);
          sendTo(host && host.ws, { type: "guestRequest", guestId, name, seatId: wanted });
          return;
        }

        sendTo(ws, { type: "error", code: "roomFull" });
        return;
      }

      if (room.resumeLobby) {
        const guestId = room.nextGuestId++;
        const preferred = message.preferredSeat;
        const draft = preferred ? room.seatDraft[preferred] : null;
        let autoSeated = false;
        if (draft && draft.kind === "passive") { draft.kind = "human"; draft.guestId = guestId; autoSeated = true; }
        room.guests.push({ ws, guestId, name, requestedSeat: autoSeated ? preferred : null });
        ws.roomCode = code;
        ws.guestId = guestId;
        sendTo(ws, { type: "roomJoined", roomCode: code, playerId: null, guestId, mapId: room.mapId, resumeLobby: true });
        sendRoomUpdate(room);
        return;
      }

      // Новое лобби: свободное место В ПРЕДЕЛАХ вместимости карты -> авто-посадка
      const maxSeats = mapMaxSeats(room);
      const usedIds = [
        ...room.players.map(p => p.id),
        ...room.lobbyBots.map(b => b.id)
      ];
      let newId = null;
      for (let id = 1; id <= maxSeats; id++) {
        if (!usedIds.includes(id)) { newId = id; break; }
      }

      if (newId !== null) {
        room.players.push({ ws, id: newId, name, ready: false, hasState: false });
        ws.roomCode = code;
        ws.playerId = newId;
        sendTo(ws, { type: "roomJoined", roomCode: code, playerId: newId, mapId: room.mapId });
        sendRoomUpdate(room);
        console.log(`Игрок ${newId} зашёл в комнату ${code}`);
        return;
      }

      // Мест нет: наблюдатель (лимит MAX_SPECTATORS)
      if ((room.spectators || []).length >= MAX_SPECTATORS) {
        sendTo(ws, { type: "error", code: "spectatorsFull" });
        return;
      }

      const spectatorId = room.nextSpectatorId++;
      room.spectators.push({ ws, id: spectatorId, name });
      ws.roomCode = code;
      ws.spectatorId = spectatorId;
      sendTo(ws, { type: "roomJoined", roomCode: code, playerId: null, spectatorId, mapId: room.mapId });
      sendRoomUpdate(room);

      // Хосту — только информационное сообщение, без кнопок
      const host = room.players.find(p => p.id === 1);
      sendTo(host && host.ws, { type: "spectatorJoined", spectatorId, name });
      console.log(`Наблюдатель ${spectatorId} (${name}) в комнате ${code}`);
      return;
    }

    // ---------- Готовность / карта ----------
    if (message.type === "setReady") {
      const room = getRoom(ws);
      if (!room || room.resumeLobby) return;
      const player = room.players.find(p => p.ws === ws);
      if (!player) return;
      player.ready = !!message.ready;
      sendRoomUpdate(room);
      return;
    }

    if (message.type === "setMap") {
      const room = getRoom(ws);
      if (!room || room.phase !== "lobby" || ws.playerId !== 1) return;
      if (room.resumeLobby || room.saveData) return;
      room.mapId = String(message.mapId || "classic").slice(0, 32);

      // Смена карты на меньшую вместимость: срезаем лишние места
      const maxSeats = mapMaxSeats(room);
      room.lobbyBots = room.lobbyBots.filter(b => b.id <= maxSeats);
      const excess = room.players.filter(p => p.id !== 1 && p.id > maxSeats);
      for (const p of excess) {
        const spectatorId = room.nextSpectatorId++;
        room.spectators.push({ ws: p.ws, id: spectatorId, name: p.name });
        p.ws.playerId = null;
        p.ws.spectatorId = spectatorId;
        sendTo(p.ws, { type: "roomJoined", roomCode: p.ws.roomCode, playerId: null, spectatorId, mapId: room.mapId });
      }
      room.players = room.players.filter(p => p.id === 1 || p.id <= maxSeats);

      sendRoomUpdate(room);
      return;
    }

    // ---------- Рассадка в лобби возврата ----------
    if (message.type === "setSeat") {
      const room = getRoom(ws);
      if (!room || !room.resumeLobby || ws.playerId !== 1) return;
      const seatId = message.seatId;
      const kind = message.kind;
      if (!room.seatDraft[seatId] || seatId === 1) return;
      if (kind !== "human" && kind !== "passive" && kind !== "eliminate" && kind !== "bot") return;

      const guestId = kind === "human" ? message.guestId : null;
      const personality = message.personality === "aggressive" ? "aggressive" : "balanced";
      if (guestId !== null) {
        for (const key of Object.keys(room.seatDraft)) {
          const d = room.seatDraft[key];
          if (d.guestId === guestId && Number(key) !== seatId) { d.kind = "passive"; d.guestId = null; }
        }
      }
      room.seatDraft[seatId] = kind === "bot"
        ? { kind: "bot", personality, guestId: null }
        : { kind, guestId };
      sendRoomUpdate(room);
      return;
    }

    // ---------- Старт обычной игры ----------
    if (message.type === "startGame") {
      const room = getRoom(ws);
      if (!room || room.resumeLobby) return;
      if (ws.playerId !== 1) return;

      const seats = [
        ...room.players.map(p => ({ id: p.id, kind: "human" })),
        ...room.lobbyBots.map(b => ({ id: b.id, kind: "bot", personality: b.personality }))
      ];

      const mapDef = getMapById(room.mapId);
      const maxSeats = mapMaxSeats(room);

      if (seats.length < 2 || seats.length > maxSeats) return;
      if (!mapDef.players.includes(seats.length)) return;
      if (seats.some(s => s.id > maxSeats)) return;
      if (!room.players.every(p => p.ready)) return;

      const uniq = new Set(seats.map(s => s.id));
      if (uniq.size !== seats.length) {
        console.error(`Старт отклонён: дубли мест в комнате ${ws.roomCode}`);
        sendTo(ws, { type: "error", code: "roomFull" });
        return;
      }

      room.phase = "game";
      room.turn = 1;
      room.seats = seats;

      initGame(null, null, { mapId: room.mapId, seats: seats.map(s => s.id) });
      state.seatKinds = {};
      for (const seat of seats) state.seatKinds[seat.id] = seat.kind;
      saveMirror(room);
      initRelations(room);

      for (const player of room.players) player.hasState = true;

      broadcastToRoom(room, {
        type: "gameStart",
        mapId: room.mapId,
        seats: seats.slice(),
        eliminated: [],
        turn: 1,
        relations: room.relations
      });
      sendTurnChecksum(room);
      armTurnDriver(room);
      console.log(`Игра началась в комнате ${ws.roomCode}: ` + seats.map(s => `${s.id}:${s.kind}`).join(", "));
      return;
    }

    // ---------- Старт возобновлённой игры ----------
    if (message.type === "startResumeGame") {
      const room = getRoom(ws);
      if (!room || !room.resumeLobby || ws.playerId !== 1) return;

      const eliminated = [];
      const seats = [];
      const players = [];
      const savedIds = room.saveData.players.map(p => p.id).sort((a, b) => a - b);

      for (const seatId of savedIds) {
        const draft = room.seatDraft[seatId] || { kind: "passive" };
        if (draft.kind === "eliminate") { eliminated.push(seatId); continue; }
        seats.push({ id: seatId, kind: draft.kind, personality: draft.personality || null });
        if (draft.kind === "human") {
          if (seatId === 1) {
            players.push(room.players.find(p => p.id === 1));
          } else {
            const guest = (room.guests || []).find(g => g.guestId === draft.guestId);
            if (guest) {
              players.push({ ws: guest.ws, id: seatId, name: guest.name, ready: true, hasState: false });
            } else {
              seats[seats.length - 1].kind = "passive";
              seats[seats.length - 1].personality = null;
            }
          }
        }
      }
      if (players.length === 0) return;

      const seatedGuestIds = new Set(
        Object.values(room.seatDraft).filter(d => d.kind === "human" && d.guestId !== null).map(d => d.guestId)
      );
      for (const guest of room.guests || []) {
        if (!seatedGuestIds.has(guest.guestId)) {
          sendTo(guest.ws, { type: "resumeStartedWithoutYou" });
          guest.ws.roomCode = null;
          guest.ws.guestId = null;
        }
      }

      room.players = players;
      room.guests = [];
      room.seats = seats;
      room.resumeLobby = false;
      room.phase = "game";

      for (const player of players) {
        player.ws.playerId = player.id;
        player.ws.roomCode = ws.roomCode;
        player.ws.guestId = null;
        sendTo(player.ws, { type: "roomJoined", roomCode: ws.roomCode, playerId: player.id, mapId: room.mapId });
      }

      let turn = room.saveData.turn;
      if (!seats.some(s => s.id === turn)) turn = nextSeat(room, turn);
      room.turn = turn;

      room.mirror = room.saveData.state;
      loadMirror(room);
      for (const id of eliminated) eliminatePlayer(id, id === state.currentPlayer ? turn : null);
      state.seatKinds = {};
      for (const seat of seats) state.seatKinds[seat.id] = seat.kind;
      saveMirror(room);
      normalizeRelations(room);

      console.log(
        `Реестр мест комнаты ${ws.roomCode}: ` + seats.map(s => `${s.id}:${s.kind}`).join(", ") +
        ` | устранены: [${eliminated.join(", ")}] | ход: ${turn}`
      );

      broadcastToRoom(room, {
        type: "gameStart",
        mapId: room.mapId,
        seats: seats.slice(),
        eliminated,
        turn,
        resume: true,
        relations: room.relations
      });
      broadcastToRoom(room, { type: "fullState", state: room.mirror });
      sendTurnChecksum(room);

      for (const player of players) player.hasState = true;
      armTurnDriver(room);
      console.log(`Возобновлённая игра стартовала в комнате ${ws.roomCode}`);
      return;
    }

    // ---------- Возврат владельца пассив-места ----------
    if (message.type === "acceptGuest") {
      const room = getRoom(ws);
      if (!room || room.phase !== "game" || ws.playerId !== 1) return;
      const guest = (room.guests || []).find(g => g.guestId === message.guestId);
      const seat = (room.seats || []).find(s => s.id === message.seatId && s.kind === "passive");
      if (!guest || !seat) return;

      seat.kind = "human";
      seat.personality = null;
      room.guests = room.guests.filter(g => g !== guest);
      room.players.push({ ws: guest.ws, id: seat.id, name: guest.name, ready: true, hasState: false });
      guest.ws.roomCode = ws.roomCode;
      guest.ws.playerId = seat.id;
      guest.ws.guestId = null;

      sendTo(guest.ws, { type: "roomJoined", roomCode: ws.roomCode, playerId: seat.id, mapId: room.mapId });
      broadcastToRoom(room, { type: "playerReturned", playerId: seat.id, seats: room.seats.slice() });

      if (room.mirror) { loadMirror(room); state.seatKinds[seat.id] = "human"; saveMirror(room); }
      if (room.relations && !room.relations[seat.id]) room.relations[seat.id] = {};

      clearTimeout(room.autoTimer);
      room.pendingStateFor = seat.id;
      for (const player of room.players) {
        if (player.id !== seat.id) sendTo(player.ws, { type: "requestState" });
      }
      armStateFallback(room, seat.id, ws.roomCode);
      sendRelations(room);
      return;
    }

    if (message.type === "denyGuest") {
      const room = getRoom(ws);
      if (!room || ws.playerId !== 1) return;
      const guest = (room.guests || []).find(g => g.guestId === message.guestId);
      if (!guest) return;
      sendTo(guest.ws, { type: "guestRequestDenied" });
      room.guests = room.guests.filter(g => g !== guest);
      guest.ws.roomCode = null;
      guest.ws.guestId = null;
      return;
    }

    // ---------- Выход ----------
    if (message.type === "leaveRoom") {
      const code = ws.roomCode;
      const room = getRoom(ws);
      if (!room) return;
      const playerId = ws.playerId;
      ws.roomCode = null;
      ws.playerId = null;

      if (ws.spectatorId !== null && playerId === null) {
        room.spectators = (room.spectators || []).filter(s => s.ws !== ws);
        ws.spectatorId = null;
        sendRoomUpdate(room);
        return;
      }

      room.players = room.players.filter(p => p.ws !== ws);

      if (room.phase === "lobby") {
        if (playerId === 1) {
          for (const player of room.players) sendTo(player.ws, { type: "roomClosed", code: "hostLeft" });
          for (const guest of room.guests || []) sendTo(guest.ws, { type: "roomClosed", code: "hostLeft" });
          for (const spec of room.spectators || []) sendTo(spec.ws, { type: "roomClosed", code: "hostLeft" });
          rooms.delete(code);
          console.log(`Комната ${code} закрыта: хост вышел`);
        } else {
          sendRoomUpdate(room);
          if (room.players.length === 0 && (room.guests || []).length === 0 && (room.spectators || []).length === 0) rooms.delete(code);
        }
      } else {
        eliminateSeat(room, code, playerId);
      }
      return;
    }

    // ---------- Rejoin ----------
    if (message.type === "rejoinRoom") {
      const room = rooms.get(message.roomCode);
      if (!room || room.phase !== "game") { sendTo(ws, { type: "gameGone" }); return; }

      // Новый клиент с чужим штампом — отклоняем; старый клиент без штампа
      // пропускаем: его выровняет контрольная сумма на ближайшем ходе
      if (message.build && message.build !== BUILD) {
        sendTo(ws, { type: "error", code: "clientOutdated" });
        return;
      }

      const slot = room.players.find(p => p.id === message.playerId);
      if (!slot || !slot.disconnected) { sendTo(ws, { type: "gameGone" }); return; }

      slot.ws = ws;
      slot.disconnected = false;
      slot.hasState = false;
      clearTimeout(slot.disconnectTimer);
      slot.disconnectTimer = null;
      ws.roomCode = message.roomCode;
      ws.playerId = message.playerId;

      sendTo(ws, { type: "rejoinOk", playerId: message.playerId, roomCode: message.roomCode });
      for (const player of room.players) {
        if (player.id !== message.playerId) sendTo(player.ws, { type: "opponentReconnected", playerId: message.playerId });
      }
      room.pendingStateFor = message.playerId;
      for (const player of room.players) {
        if (player.id !== message.playerId) sendTo(player.ws, { type: "requestState" });
      }
      armStateFallback(room, message.playerId, message.roomCode);
      sendRelations(room);
      return;
    }

    // ---------- Синхронизация состояния ----------
    if (message.type === "fullState") {
      const room = getRoom(ws);
      if (!room || room.phase !== "game") return;
      const targetId = room.pendingStateFor;
      if (targetId === undefined || targetId === ws.playerId) return;
      const target = room.players.find(p => p.id === targetId);
      sendTo(target && target.ws, { type: "fullState", state: message.state });
      if (target) target.hasState = true;
      room.pendingStateFor = undefined;
      return;
    }

    // ---------- Запрос ресинка из зеркала (несовпадение контрольной суммы) ----------
    if (message.type === "resyncRequest") {
      const room = getRoom(ws);
      if (!room || room.phase !== "game" || !room.mirror) return;

      loadMirror(room);
      const mirrorSum = computeChecksum(state);
      console.log(
        `[sync] место ${ws.playerId} запросило ресинк: local=${message.local || "?"}, mirror=${mirrorSum}`
      );
      sendTo(ws, { type: "fullState", state: room.mirror });
      return;
    }

    // ---------- Боевое устранение (с серверной валидацией) ----------
    if (message.type === "reportElimination") {
      const room = getRoom(ws);
      if (!room || room.phase !== "game") return;
      const playerId = message.playerId;
      const seat = (room.seats || []).find(s => s.id === playerId);
      if (!seat) return;

      loadMirror(room);
      const hasUnits = state.units.some(u => u.owner === playerId);
      let hasTerritory = false;
      for (const owner of state.owners.values()) {
        if (owner === playerId) { hasTerritory = true; break; }
      }
      saveMirror(room);

      if (hasUnits || hasTerritory) return;
      eliminateSeat(room, ws.roomCode, playerId);
      return;
    }

    // ---------- Конец игры ----------
    if (message.type === "gameOver") {
      const room = getRoom(ws);
      if (!room || room.gameOverNotified) return;
      room.gameOverNotified = true;
      clearTimeout(room.autoTimer);
      broadcastToRoom(room, { type: "gameOver", winner: message.winner });
      return;
    }

    // ---------- Игровые действия ----------
    if (message.type === "gameAction") {
      const room = getRoom(ws);
      if (!room || room.phase !== "game") return;
      if (ws.playerId !== room.turn) return;
      ws.hasState = true;

      const text = JSON.stringify(message);
      for (const player of room.players) {
        if (player.ws === ws || !player.ws) continue;
        try {
          if (player.ws.readyState === 1) player.ws.send(text);
        } catch (error) {
          console.error("Не удалось переслать действие:", error.message);
        }
      }
      for (const spec of room.spectators || []) {
        try {
          if (spec.ws && spec.ws.readyState === 1) spec.ws.send(text);
        } catch (error) {
          console.error("Не удалось переслать действие наблюдателю:", error.message);
        }
      }

      applyActionWithRelations(room, message.action, ws.playerId);

      if (message.action && message.action.kind === "endTurn") {
        room.turn = room.mirror.currentPlayer;
        sendRelations(room);
        sendTurnChecksum(room);
        armTurnDriver(room);
      }
      return;
    }

    // ---------- Контрольная сумма хода: клиент сверяет локальное состояние ----------
    // (сообщение приходит только от сервера; обработка на клиенте в main.js)
  });

  // ---------- Отключение ----------
  ws.on("close", () => {
    console.log("Игрок отключился");
    const code = ws.roomCode;
    const playerId = ws.playerId;
    const guestId = ws.guestId;
    const spectatorId = ws.spectatorId;
    ws.roomCode = null;
    ws.playerId = null;
    ws.guestId = null;
    ws.spectatorId = null;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    if (spectatorId !== null && playerId === null) {
      room.spectators = (room.spectators || []).filter(s => s.id !== spectatorId);
      sendRoomUpdate(room);
      return;
    }

    if (guestId !== null && playerId === null) {
      room.guests = (room.guests || []).filter(g => g.guestId !== guestId);
      sendRoomUpdate(room);
      return;
    }

    if (room.phase !== "game") {
      const remaining = room.players.filter(player => player.ws !== ws);
      const leftCode = playerId === 1 ? "hostLeft" : "playerLeft";
      for (const player of remaining) sendTo(player.ws, { type: "roomClosed", code: leftCode });
      for (const guest of room.guests || []) sendTo(guest.ws, { type: "roomClosed", code: leftCode });
      for (const spec of room.spectators || []) sendTo(spec.ws, { type: "roomClosed", code: leftCode });
      rooms.delete(code);
      console.log(`Комната ${code} закрыта из-за отключения`);
      return;
    }

    const slot = room.players.find(p => p.id === playerId);
    if (!slot || slot.ws !== ws) return;
    slot.disconnected = true;
    slot.ws = null;
    for (const player of room.players) {
      if (player.id !== playerId) sendTo(player.ws, { type: "opponentDisconnected", playerId });
    }
    clearTimeout(slot.disconnectTimer);
    slot.disconnectTimer = setTimeout(() => {
      const current = rooms.get(code);
      if (!current) return;
      const stillSlot = current.players.find(p => p.id === playerId);
      if (!stillSlot || !stillSlot.disconnected) return;
      eliminateSeat(current, code, playerId);
    }, RECONNECT_GRACE_MS);
  });
});