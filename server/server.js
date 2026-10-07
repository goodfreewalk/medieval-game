import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import express from "express";
import { WebSocketServer } from "ws";

// Общая боевая логика с клиентом — единый источник правил
import { state, initGame } from "../public/js/state.js";
import {
  applyMove,
  applyAttack,
  applyRecruit,
  applyEndTurn,
  eliminatePlayer
} from "../public/js/logic.js";
import { planBotAction } from "./bots.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 4;

// Сохранения партий
const SAVES_DIR = path.join(__dirname, "..", "saves");
const SAVE_VERSION = 1;
const SAVE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней
fs.mkdirSync(SAVES_DIR, { recursive: true });

// Пауза пассивного хода
const AUTO_TURN_DELAY_MS = 4000;

// Темп бота: первая пауза длиннее (человек успевает увидеть ход), шаги чаще
const BOT_FIRST_STEP_MS = 900;
const BOT_STEP_DELAY_MS = 500;
const BOT_MAX_STEPS = 40;

// Ожидание возврата отключившегося игрока
const RECONNECT_GRACE_MS = 60000;

// Сколько ждём fullState от соперников, прежде чем включить резерв
const STATE_FALLBACK_MS = 3000;

const app = express();

app.use(
  express.static(path.join(__dirname, "..", "public"), {
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-cache");
    }
  })
);

const httpServer = app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: 64 * 1024
});

console.log("WebSocket готов");

// Комната: {
//   players: [{ ws, id, name, ready, disconnected, disconnectTimer, hasState }],
//   guests: [{ ws, guestId, name, requestedSeat }],
//   lobbyBots: [{ id, personality }] (боты обычного лобби),
//   phase: "lobby" | "game",
//   resumeLobby: bool,
//   saveData: объект сохранения,
//   seatDraft: { seatId: { kind, guestId, personality } },
//   seats: [{ id, kind: "human" | "passive" | "bot", personality }],
//   mirror: снапшот состояния (формат fullState),
//   mapId, turn, autoTimer, botSteps, pendingStateFor,
//   nextGuestId, gameOverNotified
// }
const rooms = new Map();

// ---------- Сохранения ----------

function savePath(code) {
  return path.join(SAVES_DIR, `${code}.json`);
}

function cleanOldSaves() {
  let files = [];
  try {
    files = fs.readdirSync(SAVES_DIR);
  } catch {
    return;
  }

  const now = Date.now();

  for (const file of files) {
    const full = path.join(SAVES_DIR, file);
    try {
      const save = JSON.parse(fs.readFileSync(full, "utf8"));
      if (!save || now - (save.savedAt || 0) > SAVE_TTL_MS) {
        fs.unlinkSync(full);
      }
    } catch {
      try {
        fs.unlinkSync(full);
      } catch {}
    }
  }
}
cleanOldSaves();

function readSave(code) {
  try {
    const save = JSON.parse(fs.readFileSync(savePath(code), "utf8"));

    if (!save || save.version !== SAVE_VERSION) {
      return { error: "saveIncompatible" };
    }

    if (Date.now() - (save.savedAt || 0) > SAVE_TTL_MS) {
      try {
        fs.unlinkSync(savePath(code));
      } catch {}
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

// Применяем действие к зеркалу той же логикой, что и у клиентов
function applyActionToMirror(room, action) {
  loadMirror(room);

  if (action.kind === "move") {
    applyMove(action.unitId, action.x, action.y);
  } else if (action.kind === "attack") {
    applyAttack(action.attackerId, action.targetId);
  } else if (action.kind === "recruit") {
    applyRecruit(action.type, action.x, action.y);
  } else if (action.kind === "endTurn") {
    applyEndTurn();
  }

  saveMirror(room);
}

// ---------- Вспомогательные ----------

function getRoom(ws) {
  if (!ws.roomCode) {
    return null;
  }
  return rooms.get(ws.roomCode) || null;
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

function broadcastToRoom(room, message) {
  const text = JSON.stringify(message);
  for (const player of room.players) {
    try {
      if (player.ws && player.ws.readyState === 1) {
        player.ws.send(text);
      }
    } catch (error) {
      console.error("Не удалось отправить сообщение:", error.message);
    }
  }
}

function sendTo(ws, message) {
  try {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
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
    saveInfo: room.saveData
      ? { seats: room.saveData.players, turn: room.saveData.turn }
      : null,
    guests: (room.guests || []).map(g => ({
      guestId: g.guestId,
      name: g.name,
      requestedSeat: g.requestedSeat
    })),
    players: room.players.map(player => ({
      id: player.id,
      name: player.name,
      ready: player.ready
    }))
  });
}

// Следующее место по реестру (по кругу, по возрастанию id)
function nextSeat(room, fromId) {
  const ids = (room.seats || []).map(s => s.id).sort((a, b) => a - b);

  if (ids.length === 0) {
    return fromId;
  }

  const index = ids.indexOf(fromId);
  const start = index === -1 ? 0 : index + 1;

  return ids[start % ids.length];
}

function seatKind(room, id) {
  const seat = (room.seats || []).find(s => s.id === id);
  return seat ? seat.kind : null;
}

// ---------- Драйвер автоматических мест (пассив и боты) ----------

function armTurnDriver(room) {
  clearTimeout(room.autoTimer);
  room.autoTimer = null;

  if (room.phase !== "game" || !room.mirror) {
    return;
  }

  const kind = seatKind(room, room.turn);

  // Пассив: сервер сам пропускает ход
  if (kind === "passive") {
    room.autoTimer = setTimeout(() => {
      if (room.phase !== "game" || seatKind(room, room.turn) !== "passive") {
        return;
      }

      const action = { kind: "endTurn" };
      applyActionToMirror(room, action);
      action.next = room.mirror.currentPlayer;

      broadcastToRoom(room, { type: "gameAction", action });
      room.turn = action.next;
      armTurnDriver(room);
    }, AUTO_TURN_DELAY_MS);
    return;
  }

  // Бот: серия шагов с паузами
  if (kind === "bot") {
    room.botSteps = 0;
    room.autoTimer = setTimeout(() => botStep(room), BOT_FIRST_STEP_MS);
  }
}

function botStep(room) {
  if (room.phase !== "game" || !room.mirror) {
    return;
  }

  if (seatKind(room, room.turn) !== "bot") {
    return;
  }

  loadMirror(room);

  if (state.gameOver || state.currentPlayer !== room.turn) {
    saveMirror(room);
    return;
  }

  const seat = room.seats.find(s => s.id === room.turn);
  const action = room.botSteps < BOT_MAX_STEPS
    ? planBotAction(state, seat.personality || "balanced")
    : null;

  if (action) {
    room.botSteps += 1;
    applyActionToMirror(room, action);
    broadcastToRoom(room, { type: "gameAction", action });
    room.autoTimer = setTimeout(() => botStep(room), BOT_STEP_DELAY_MS);
    return;
  }

  // Делать больше нечего — завершаем ход
  const endAction = { kind: "endTurn" };
  applyActionToMirror(room, endAction);
  endAction.next = room.mirror.currentPlayer;

  broadcastToRoom(room, { type: "gameAction", action: endAction });
  room.turn = endAction.next;
  armTurnDriver(room);
}

// ---------- Резерв синхронизации состояния ----------

function armStateFallback(room, targetId, code) {
  setTimeout(() => {
    if (room.pendingStateFor !== targetId) {
      return;
    }

    room.pendingStateFor = undefined;

    const slot = room.players.find(p => p.id === targetId);
    if (!slot || !slot.ws || slot.ws.readyState !== 1) {
      return;
    }

    // Источники по приоритету: живое зеркало → сейв резюма → сейв на диске
    let fallback = room.mirror || null;

    if (!fallback && room.saveData) {
      fallback = room.saveData.state;
    }

    if (!fallback) {
      const { save } = readSave(code);
      if (save) {
        fallback = save.state;
      }
    }

    if (fallback) {
      slot.hasState = true;
      sendTo(slot.ws, { type: "fullState", state: fallback });
      console.log(`Состояние для места ${targetId} восстановлено из резерва`);
    } else {
      // Источника нет совсем: освобождаем слот, чтобы зомби-сокет
      // не блокировал резюм и вход по карточке
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
  if (slot) {
    clearTimeout(slot.disconnectTimer);
  }
  clearTimeout(room.autoTimer);

  room.players = room.players.filter(p => p.id !== playerId);
  room.seats = (room.seats || []).filter(s => s.id !== playerId);

  if (room.turn === playerId || !room.seats.some(s => s.id === room.turn)) {
    room.turn = nextSeat(room, playerId);
  }

  if (room.mirror) {
    loadMirror(room);
    eliminatePlayer(playerId, room.turn);
    saveMirror(room);
  }

  broadcastToRoom(room, {
    type: "playerEliminated",
    playerId,
    nextTurn: room.turn
  });

  armTurnDriver(room);

  if (room.players.length === 0 && (room.guests || []).length === 0) {
    rooms.delete(code);
    console.log(`Комната ${code} пуста после устранения`);
  } else {
    console.log(`Игрок ${playerId} устранён в комнате ${code}, ход: ${room.turn}`);
  }
}

// ---------- Heartbeat ----------

const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on("close", () => {
  clearInterval(heartbeatInterval);
});

wss.on("error", (error) => {
  console.error("Ошибка WebSocket-сервера:", error);
});

wss.on("connection", (ws) => {
  console.log("Игрок подключился");

  ws.roomCode = null;
  ws.playerId = null;
  ws.guestId = null;
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("error", (error) => {
    console.error("Ошибка соединения игрока:", error.message);
  });

  ws.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    // ---------- Создание комнаты ----------
    if (message.type === "createRoom") {
      const code = generateRoomCode();
      const room = {
        players: [],
        guests: [],
        lobbyBots: [],
        phase: "lobby",
        resumeLobby: false,
        turn: 1,
        mapId: "classic",
        nextGuestId: 1
      };
      rooms.set(code, room);

      room.players.push({
        ws,
        id: 1,
        name: String(message.name || "Игрок 1").slice(0, 24),
        ready: false,
        hasState: false
      });

      ws.roomCode = code;
      ws.playerId = 1;

      sendTo(ws, {
        type: "roomCreated",
        roomCode: code,
        playerId: 1,
        mapId: room.mapId
      });
      sendRoomUpdate(room);
      console.log(`Создана комната ${code}`);
      return;
    }

    // ---------- Боты в новом лобби (только хост) ----------
    if (message.type === "addBot") {
      const room = getRoom(ws);
      if (!room || room.phase !== "lobby" || room.resumeLobby) {
        return;
      }
      if (ws.playerId !== 1) {
        return;
      }
      if (room.players.length + room.lobbyBots.length >= MAX_PLAYERS) {
        return;
      }

      const personality =
        message.personality === "aggressive" ? "aggressive" : "balanced";

      const usedIds = [
        ...room.players.map(p => p.id),
        ...room.lobbyBots.map(b => b.id)
      ];
      let newId = null;
      for (let id = 1; id <= MAX_PLAYERS; id++) {
        if (!usedIds.includes(id)) {
          newId = id;
          break;
        }
      }

      room.lobbyBots.push({ id: newId, personality });
      sendRoomUpdate(room);
      console.log(`Бот ${newId} (${personality}) добавлен в комнату ${ws.roomCode}`);
      return;
    }

    if (message.type === "removeBot") {
      const room = getRoom(ws);
      if (!room || room.phase !== "lobby" || room.resumeLobby) {
        return;
      }
      if (ws.playerId !== 1) {
        return;
      }

      room.lobbyBots = room.lobbyBots.filter(b => b.id !== message.botId);
      sendRoomUpdate(room);
      return;
    }

    // ---------- Сохранение партии (только хост, только в игре) ----------
    if (message.type === "saveGame") {
      const room = getRoom(ws);
      if (!room || room.phase !== "game" || ws.playerId !== 1) {
        return;
      }

      const token = crypto.randomBytes(8).toString("hex");

      const save = {
        version: SAVE_VERSION,
        savedAt: Date.now(),
        mapId: room.mapId,
        turn: room.turn,
        players: (room.seats || []).map(s => {
          const human = room.players.find(p => p.id === s.id);
          return {
            id: s.id,
            kind: s.kind,
            personality: s.personality || null,
            name: human ? human.name : null
          };
        }),
        // Зеркало сервера — самый свежий источник состояния
        state: room.mirror || message.state,
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

    // ---------- Возобновление: открывает только хост (по ключу) ----------
    if (message.type === "resumeGame") {
      const code = String(message.roomCode || "").toUpperCase();

      if (rooms.has(code)) {
        const existing = rooms.get(code);
        const statefulConnected = existing.players.some(
          p => !p.disconnected && p.hasState
        );

        if (!statefulConnected) {
          // Никто не держит живое состояние: закрываем зомби-комнату
          // и стартуем из сейва. Гостям в заявках сообщаем о закрытии
          clearTimeout(existing.autoTimer);
          for (const p of existing.players) {
            clearTimeout(p.disconnectTimer);
          }
          for (const guest of existing.guests || []) {
            sendTo(guest.ws, { type: "roomClosed", code: "hostLeft" });
          }
          rooms.delete(code);
        } else {
          // Игра реально живая. Хост с ключом возвращается в своё место,
          // если его слот отключён
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
              if (player.id !== 1) {
                sendTo(player.ws, {
                  type: "opponentReconnected",
                  playerId: 1
                });
              }
            }

            existing.pendingStateFor = 1;

            for (const player of existing.players) {
              if (player.id !== 1) {
                sendTo(player.ws, { type: "requestState" });
              }
            }

            armStateFallback(existing, 1, code);
            return;
          }

          // Хост уже в игре (например, во второй вкладке)
          sendTo(ws, { type: "error", code: "gameInProgress" });
          return;
        }
      }

      const { save, error } = readSave(code);

      if (error) {
        sendTo(ws, { type: "error", code: error });
        return;
      }

      if (!save.token || save.token !== message.token) {
        sendTo(ws, { type: "error", code: "resumeNotHost" });
        return;
      }

      const room = {
        players: [],
        guests: [],
        lobbyBots: [],
        phase: "lobby",
        resumeLobby: true,
        saveData: save,
        mapId: save.mapId,
        turn: save.turn,
        nextGuestId: 1,
        seatDraft: {}
      };

      for (const seat of save.players) {
        if (seat.id === 1) {
          room.seatDraft[seat.id] = { kind: "human", guestId: null };
        } else if (seat.kind === "bot") {
          room.seatDraft[seat.id] = {
            kind: "bot",
            personality: seat.personality || "balanced",
            guestId: null
          };
        } else {
          room.seatDraft[seat.id] = { kind: "passive", guestId: null };
        }
      }

      rooms.set(code, room);

      room.players.push({
        ws,
        id: 1,
        name: String(message.name || "Игрок 1").slice(0, 24),
        ready: true,
        hasState: false
      });

      ws.roomCode = code;
      ws.playerId = 1;

      sendTo(ws, {
        type: "roomJoined",
        roomCode: code,
        playerId: 1,
        mapId: room.mapId,
        resumeLobby: true
      });
      sendRoomUpdate(room);
      console.log(`Комната ${code} возобновлена из сохранения`);
      return;
    }

    // ---------- Вход в комнату ----------
    if (message.type === "joinRoom") {
      const room = rooms.get(message.roomCode);

      // Комнаты нет: возможно, есть сохранение — тогда ждём хоста
      if (!room) {
        const { save } = readSave(message.roomCode);
        sendTo(ws, {
          type: "error",
          code: save ? "resumeNotOpened" : "roomNotFound"
        });
        return;
      }

      const name = String(message.name || "Игрок").slice(0, 24);

      // Живая игра: три исхода
      if (room.phase === "game") {
        const wanted = message.preferredSeat;
        const seat = (room.seats || []).find(s => s.id === wanted);

        // 1) Место человека отключено — возвращаем в живую партию
        if (seat && seat.kind === "human") {
          const slot = room.players.find(p => p.id === wanted);

          if (slot && slot.disconnected) {
            slot.ws = ws;
            slot.disconnected = false;
            slot.hasState = false;

            clearTimeout(slot.disconnectTimer);
            slot.disconnectTimer = null;

            ws.roomCode = message.roomCode;
            ws.playerId = wanted;

            sendTo(ws, {
              type: "rejoinOk",
              playerId: wanted,
              roomCode: message.roomCode
            });

            for (const player of room.players) {
              if (player.id !== wanted) {
                sendTo(player.ws, {
                  type: "opponentReconnected",
                  playerId: wanted
                });
              }
            }

            room.pendingStateFor = wanted;

            for (const player of room.players) {
              if (player.id !== wanted) {
                sendTo(player.ws, { type: "requestState" });
              }
            }

            armStateFallback(room, wanted, message.roomCode);
            return;
          }

          // Место занято подключённым игроком
          sendTo(ws, { type: "error", code: "roomFull" });
          return;
        }

        // 2) Пассив-место: заявка на передачу (хост подтверждает панелью)
        if (seat && seat.kind === "passive") {
          const guestId = room.nextGuestId++;
          room.guests.push({ ws, guestId, name, requestedSeat: wanted });
          ws.roomCode = message.roomCode;
          ws.guestId = guestId;

          sendTo(ws, { type: "waitingApproval" });

          const host = room.players.find(p => p.id === 1);
          sendTo(host && host.ws, {
            type: "guestRequest",
            guestId,
            name,
            seatId: wanted
          });
          return;
        }

        // 3) Места нет (устранено или бот) — войти нельзя
        sendTo(ws, { type: "error", code: "roomFull" });
        return;
      }

      // Лобби возврата: авторассадка по личной памяти или пул гостей
      if (room.resumeLobby) {
        const guestId = room.nextGuestId++;
        const preferred = message.preferredSeat;
        const draft = preferred ? room.seatDraft[preferred] : null;
        let autoSeated = false;

        if (draft && draft.kind === "passive") {
          draft.kind = "human";
          draft.guestId = guestId;
          autoSeated = true;
        }

        room.guests.push({
          ws,
          guestId,
          name,
          requestedSeat: autoSeated ? preferred : null
        });
        ws.roomCode = message.roomCode;
        ws.guestId = guestId;

        sendTo(ws, {
          type: "roomJoined",
          roomCode: message.roomCode,
          playerId: null,
          guestId,
          mapId: room.mapId,
          resumeLobby: true
        });
        sendRoomUpdate(room);
        return;
      }

      // Обычное лобби
      if (room.players.length >= MAX_PLAYERS) {
        sendTo(ws, { type: "error", code: "roomFull" });
        return;
      }

      const usedIds = room.players.map(p => p.id);
      let newId = null;

      for (let id = 1; id <= MAX_PLAYERS; id++) {
        if (!usedIds.includes(id)) {
          newId = id;
          break;
        }
      }

      room.players.push({ ws, id: newId, name, ready: false, hasState: false });

      ws.roomCode = message.roomCode;
      ws.playerId = newId;

      sendTo(ws, {
        type: "roomJoined",
        roomCode: message.roomCode,
        playerId: newId,
        mapId: room.mapId
      });
      sendRoomUpdate(room);
      console.log(`Игрок ${newId} зашёл в комнату ${message.roomCode}`);
      return;
    }

    // ---------- Готовность / карта (обычное лобби) ----------
    if (message.type === "setReady") {
      const room = getRoom(ws);
      if (!room || room.resumeLobby) {
        return;
      }

      const player = room.players.find(p => p.ws === ws);
      if (!player) {
        return;
      }

      player.ready = !!message.ready;
      sendRoomUpdate(room);
      return;
    }

    if (message.type === "setMap") {
      const room = getRoom(ws);
      if (!room || room.phase !== "lobby" || ws.playerId !== 1) {
        return;
      }
      if (room.resumeLobby || room.saveData) {
        return;
      }

      room.mapId = String(message.mapId || "classic").slice(0, 32);
      sendRoomUpdate(room);
      return;
    }

    // ---------- Рассадка в лобби возврата (только хост) ----------
    if (message.type === "setSeat") {
      const room = getRoom(ws);
      if (!room || !room.resumeLobby || ws.playerId !== 1) {
        return;
      }

      const seatId = message.seatId;
      const kind = message.kind;

      if (!room.seatDraft[seatId] || seatId === 1) {
        return;
      }
      if (
        kind !== "human" &&
        kind !== "passive" &&
        kind !== "eliminate" &&
        kind !== "bot"
      ) {
        return;
      }

      const guestId = kind === "human" ? message.guestId : null;
      const personality =
        message.personality === "aggressive" ? "aggressive" : "balanced";

      // Освобождаем гостя, если он был назначен куда-то ещё
      if (guestId !== null) {
        for (const key of Object.keys(room.seatDraft)) {
          const d = room.seatDraft[key];
          if (d.guestId === guestId && Number(key) !== seatId) {
            d.kind = "passive";
            d.guestId = null;
          }
        }
      }

      room.seatDraft[seatId] =
        kind === "bot"
          ? { kind: "bot", personality, guestId: null }
          : { kind, guestId };
      sendRoomUpdate(room);
      return;
    }

    // ---------- Старт обычной игры (с ботами) ----------
    if (message.type === "startGame") {
      const room = getRoom(ws);
      if (!room || room.resumeLobby) {
        return;
      }
      if (ws.playerId !== 1) {
        return;
      }

      const seats = [
        ...room.players.map(p => ({ id: p.id, kind: "human" })),
        ...room.lobbyBots.map(b => ({
          id: b.id,
          kind: "bot",
          personality: b.personality
        }))
      ];

      if (seats.length < 2 || seats.length > MAX_PLAYERS) {
        return;
      }
      if (!room.players.every(p => p.ready)) {
        return;
      }

      room.phase = "game";
      room.turn = 1;
      room.seats = seats;

      // Зеркало: та же инициализация, что и у клиентов
      initGame(null, null, {
        mapId: room.mapId,
        seats: seats.map(s => s.id)
      });
      state.seatKinds = {};
      for (const seat of seats) {
        state.seatKinds[seat.id] = seat.kind;
      }
      saveMirror(room);

      for (const player of room.players) {
        player.hasState = true;
      }

      broadcastToRoom(room, {
        type: "gameStart",
        mapId: room.mapId,
        seats: seats.slice(),
        eliminated: [],
        turn: 1
      });
      armTurnDriver(room);
      console.log(
        `Игра началась в комнате ${ws.roomCode}: ` +
        seats.map(s => `${s.id}:${s.kind}`).join(", ")
      );
      return;
    }

    // ---------- Старт возобновлённой игры (решает хост) ----------
    if (message.type === "startResumeGame") {
      const room = getRoom(ws);
      if (!room || !room.resumeLobby || ws.playerId !== 1) {
        return;
      }

      const eliminated = [];
      const seats = [];
      const players = [];

      const savedIds = room.saveData.players
        .map(p => p.id)
        .sort((a, b) => a - b);

      for (const seatId of savedIds) {
        const draft = room.seatDraft[seatId] || { kind: "passive" };

        if (draft.kind === "eliminate") {
          eliminated.push(seatId);
          continue;
        }

        seats.push({
          id: seatId,
          kind: draft.kind,
          personality: draft.personality || null
        });

        if (draft.kind === "human") {
          if (seatId === 1) {
            players.push(room.players.find(p => p.id === 1));
          } else {
            const guest = (room.guests || []).find(
              g => g.guestId === draft.guestId
            );

            if (guest) {
              players.push({
                ws: guest.ws,
                id: seatId,
                name: guest.name,
                ready: true,
                hasState: false
              });
            } else {
              // Гость отвалился: место становится пассивным
              seats[seats.length - 1].kind = "passive";
              seats[seats.length - 1].personality = null;
            }
          }
        }
      }

      if (players.length === 0) {
        return;
      }

      // Нераспределённых гостей вежливо выводим
      const seatedGuestIds = new Set(
        Object.values(room.seatDraft)
          .filter(d => d.kind === "human" && d.guestId !== null)
          .map(d => d.guestId)
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

      // Каждый посаженный игрок узнаёт свой номер ДО gameStart
      for (const player of players) {
        player.ws.playerId = player.id;
        player.ws.roomCode = ws.roomCode;
        player.ws.guestId = null;

        sendTo(player.ws, {
          type: "roomJoined",
          roomCode: ws.roomCode,
          playerId: player.id,
          mapId: room.mapId
        });
      }

      let turn = room.saveData.turn;
      if (!seats.some(s => s.id === turn)) {
        turn = nextSeat(room, turn);
      }
      room.turn = turn;

      // Зеркало из сейва + устранения и свежие виды мест
      room.mirror = room.saveData.state;
      loadMirror(room);
      for (const id of eliminated) {
        eliminatePlayer(id, id === state.currentPlayer ? turn : null);
      }
      state.seatKinds = {};
      for (const seat of seats) {
        state.seatKinds[seat.id] = seat.kind;
      }
      saveMirror(room);

      console.log(
        `Реестр мест комнаты ${ws.roomCode}: ` +
        seats.map(s => `${s.id}:${s.kind}`).join(", ") +
        ` | устранены: [${eliminated.join(", ")}] | ход: ${turn}`
      );

      broadcastToRoom(room, {
        type: "gameStart",
        mapId: room.mapId,
        seats: seats.slice(),
        eliminated,
        turn,
        resume: true
      });

      broadcastToRoom(room, {
        type: "fullState",
        state: room.mirror
      });

      for (const player of players) {
        player.hasState = true;
      }

      armTurnDriver(room);
      console.log(`Возобновлённая игра стартовала в комнате ${ws.roomCode}`);
      return;
    }

    // ---------- Хост подтверждает возврат владельца места ----------
    if (message.type === "acceptGuest") {
      const room = getRoom(ws);
      if (!room || room.phase !== "game" || ws.playerId !== 1) {
        return;
      }

      const guest = (room.guests || []).find(
        g => g.guestId === message.guestId
      );
      const seat = (room.seats || []).find(
        s => s.id === message.seatId && s.kind === "passive"
      );

      if (!guest || !seat) {
        return;
      }

      seat.kind = "human";
      seat.personality = null;
      room.guests = room.guests.filter(g => g !== guest);

      room.players.push({
        ws: guest.ws,
        id: seat.id,
        name: guest.name,
        ready: true,
        hasState: false
      });

      guest.ws.roomCode = ws.roomCode;
      guest.ws.playerId = seat.id;
      guest.ws.guestId = null;

      sendTo(guest.ws, {
        type: "roomJoined",
        roomCode: ws.roomCode,
        playerId: seat.id,
        mapId: room.mapId
      });

      // Реестр мест едет всем: клиенты держат его как истину
      broadcastToRoom(room, {
        type: "playerReturned",
        playerId: seat.id,
        seats: room.seats.slice()
      });

      if (room.mirror) {
        loadMirror(room);
        state.seatKinds[seat.id] = "human";
        saveMirror(room);
      }

      clearTimeout(room.autoTimer);
      room.pendingStateFor = seat.id;

      for (const player of room.players) {
        if (player.id !== seat.id) {
          sendTo(player.ws, { type: "requestState" });
        }
      }

      armStateFallback(room, seat.id, ws.roomCode);
      return;
    }

    if (message.type === "denyGuest") {
      const room = getRoom(ws);
      if (!room || ws.playerId !== 1) {
        return;
      }

      const guest = (room.guests || []).find(
        g => g.guestId === message.guestId
      );
      if (!guest) {
        return;
      }

      sendTo(guest.ws, { type: "guestRequestDenied" });
      room.guests = room.guests.filter(g => g !== guest);
      guest.ws.roomCode = null;
      guest.ws.guestId = null;
      return;
    }

    // ---------- Выход из комнаты ----------
    if (message.type === "leaveRoom") {
      const code = ws.roomCode;
      const room = getRoom(ws);

      if (!room) {
        return;
      }

      const playerId = ws.playerId;
      ws.roomCode = null;
      ws.playerId = null;

      room.players = room.players.filter(p => p.ws !== ws);

      if (room.phase === "lobby") {
        if (playerId === 1) {
          for (const player of room.players) {
            sendTo(player.ws, { type: "roomClosed", code: "hostLeft" });
          }
          for (const guest of room.guests || []) {
            sendTo(guest.ws, { type: "roomClosed", code: "hostLeft" });
          }
          rooms.delete(code);
          console.log(`Комната ${code} закрыта: хост вышел`);
        } else {
          sendRoomUpdate(room);

          if (room.players.length === 0 && (room.guests || []).length === 0) {
            rooms.delete(code);
          }
        }
      } else {
        eliminateSeat(room, code, playerId);
      }

      return;
    }

    // ---------- Возврат после обрыва (rejoin) ----------
    if (message.type === "rejoinRoom") {
      const room = rooms.get(message.roomCode);

      if (!room || room.phase !== "game") {
        sendTo(ws, { type: "gameGone" });
        return;
      }

      const slot = room.players.find(p => p.id === message.playerId);

      if (!slot || !slot.disconnected) {
        sendTo(ws, { type: "gameGone" });
        return;
      }

      slot.ws = ws;
      slot.disconnected = false;
      slot.hasState = false;

      clearTimeout(slot.disconnectTimer);
      slot.disconnectTimer = null;

      ws.roomCode = message.roomCode;
      ws.playerId = message.playerId;

      sendTo(ws, {
        type: "rejoinOk",
        playerId: message.playerId,
        roomCode: message.roomCode
      });

      for (const player of room.players) {
        if (player.id !== message.playerId) {
          sendTo(player.ws, {
            type: "opponentReconnected",
            playerId: message.playerId
          });
        }
      }

      // Состояние просим у всех подключённых соперников:
      // ответит первый, у кого оно реально есть
      room.pendingStateFor = message.playerId;

      for (const player of room.players) {
        if (player.id !== message.playerId) {
          sendTo(player.ws, { type: "requestState" });
        }
      }

      armStateFallback(room, message.playerId, message.roomCode);
      return;
    }

    // ---------- Синхронизация состояния ----------
    if (message.type === "fullState") {
      const room = getRoom(ws);
      if (!room || room.phase !== "game") {
        return;
      }

      const targetId = room.pendingStateFor;
      if (targetId === undefined || targetId === ws.playerId) {
        return;
      }

      const target = room.players.find(p => p.id === targetId);
      sendTo(target && target.ws, {
        type: "fullState",
        state: message.state
      });

      if (target) {
        target.hasState = true;
      }

      room.pendingStateFor = undefined;
      return;
    }

    // ---------- Боевое устранение: репорт с клиента ----------
    if (message.type === "reportElimination") {
      const room = getRoom(ws);
      if (!room || room.phase !== "game") {
        return;
      }

      const playerId = message.playerId;
      const seat = (room.seats || []).find(s => s.id === playerId);

      if (!seat) {
        return;
      }

      eliminateSeat(room, ws.roomCode, playerId);
      return;
    }

    // ---------- Конец игры: ретрансляция всем (включая выбывших) ----------
    if (message.type === "gameOver") {
      const room = getRoom(ws);
      if (!room || room.gameOverNotified) {
        return;
      }

      room.gameOverNotified = true;
      clearTimeout(room.autoTimer);

      broadcastToRoom(room, {
        type: "gameOver",
        winner: message.winner
      });
      return;
    }

    // ---------- Игровые действия ----------
    if (message.type === "gameAction") {
      const room = getRoom(ws);
      if (!room || room.phase !== "game") {
        return;
      }

      if (ws.playerId !== room.turn) {
        return;
      }

      // Действие от игрока — доказательство, что у него есть состояние
      ws.hasState = true;

      const text = JSON.stringify(message);
      for (const player of room.players) {
        if (player.ws === ws || !player.ws) continue;
        try {
          if (player.ws.readyState === 1) {
            player.ws.send(text);
          }
        } catch (error) {
          console.error("Не удалось переслать действие:", error.message);
        }
      }

      // Зеркало применяет то же действие — сервер всегда в актуальном состоянии
      applyActionToMirror(room, message.action);

      if (message.action && message.action.kind === "endTurn") {
        room.turn = room.mirror.currentPlayer;
        armTurnDriver(room);
      }
      return;
    }
  });

  // ---------- Отключение ----------
  ws.on("close", () => {
    console.log("Игрок отключился");

    const code = ws.roomCode;
    const playerId = ws.playerId;
    const guestId = ws.guestId;
    ws.roomCode = null;
    ws.playerId = null;
    ws.guestId = null;

    if (!code) {
      return;
    }

    const room = rooms.get(code);
    if (!room) {
      return;
    }

    // Гость (не игрок) просто исчезает из пула
    if (guestId !== null && playerId === null) {
      room.guests = (room.guests || []).filter(g => g.guestId !== guestId);
      sendRoomUpdate(room);
      return;
    }

    if (room.phase !== "game") {
      const remaining = room.players.filter(player => player.ws !== ws);
      const leftCode = playerId === 1 ? "hostLeft" : "playerLeft";

      for (const player of remaining) {
        sendTo(player.ws, { type: "roomClosed", code: leftCode });
      }
      for (const guest of room.guests || []) {
        sendTo(guest.ws, { type: "roomClosed", code: leftCode });
      }

      rooms.delete(code);
      console.log(`Комната ${code} закрыта из-за отключения`);
      return;
    }

    const slot = room.players.find(p => p.id === playerId);

    if (!slot || slot.ws !== ws) {
      return;
    }

    slot.disconnected = true;
    slot.ws = null;

    for (const player of room.players) {
      if (player.id !== playerId) {
        sendTo(player.ws, { type: "opponentDisconnected", playerId });
      }
    }

    // Персональный таймер устранения у каждого слота
    clearTimeout(slot.disconnectTimer);
    slot.disconnectTimer = setTimeout(() => {
      const current = rooms.get(code);
      if (!current) {
        return;
      }

      const stillSlot = current.players.find(p => p.id === playerId);

      if (!stillSlot || !stillSlot.disconnected) {
        return;
      }

      eliminateSeat(current, code, playerId);
    }, RECONNECT_GRACE_MS);
  });
});