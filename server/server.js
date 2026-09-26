const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;

const app = express();

// Раздаём файлы клиента из папки public
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-cache");
    }
  })
);

// Запускаем HTTP-сервер
const httpServer = app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log(`Открой в браузере: http://localhost:${PORT}`);
});

// WebSocket на том же сервере и порту
// maxPayload: сообщения у нас крошечные — защита от мусора и флуда
const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: 16 * 1024
});

console.log("WebSocket готов");

// Список комнат: код -> { players, phase, turn, disconnectTimer, pendingStateFor }
const rooms = new Map();

// Сколько сервер ждёт отключившегося игрока перед удалением комнаты
const RECONNECT_GRACE_MS = 60000;

function getRoom(ws) {
  if (!ws.roomCode) {
    return null;
  }
  return rooms.get(ws.roomCode) || null;
}

// Генерируем короткий код комнаты, например "K7QF"
function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

// Отправляем сообщение всем игрокам комнаты
function broadcastToRoom(room, message) {
  const text = JSON.stringify(message);
  for (const player of room.players) {
    try {
      if (player.ws && player.ws.readyState === 1) {
        player.ws.send(text);
      }
    } catch (error) {
      // Сокет может сломаться между проверкой readyState и отправкой
      console.error("Не удалось отправить сообщение:", error.message);
    }
  }
}

// Отправляем обновлённый список игроков всем в комнате
function sendRoomUpdate(room) {
  broadcastToRoom(room, {
    type: "roomUpdate",
    players: room.players.map(player => ({
      id: player.id,
      name: player.name,
      ready: player.ready
    }))
  });
}

// Heartbeat: прокси и провайдеры часто рвут «простаивающие» соединения.
// Раз в 30 секунд пингуем всех и обрываем мёртвые сокеты.
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

// Ошибки уровня сервера (handshake и т.п.) — иначе uncaughtException
wss.on("error", (error) => {
  console.error("Ошибка WebSocket-сервера:", error);
});

wss.on("connection", (ws) => {
  console.log("Игрок подключился");

  ws.roomCode = null;
  ws.playerId = null;
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  // Без обработчика ошибка сокета (ECONNRESET, EPIPE, write after destroy)
  // становится uncaughtException и роняет ВЕСЬ процесс.
  ws.on("error", (error) => {
    console.error("Ошибка соединения игрока:", error.message);
  });

  ws.on("message", (data) => {
    // Некорректный JSON больше не роняет весь сервер
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Создание комнаты
    if (message.type === "createRoom") {
      const code = generateRoomCode();
      const room = { players: [], phase: "lobby", turn: 1 };
      rooms.set(code, room);

      room.players.push({
        ws,
        id: 1,
        name: String(message.name || "Игрок 1").slice(0, 24),
        ready: false
      });

      ws.roomCode = code;
      ws.playerId = 1;

      ws.send(
        JSON.stringify({
          type: "roomCreated",
          roomCode: code,
          playerId: 1
        })
      );
      sendRoomUpdate(room);
      console.log(`Создана комната ${code}`);
      return;
    }

    // Подключение к комнате
    if (message.type === "joinRoom") {
      const room = rooms.get(message.roomCode);

      if (!room) {
        ws.send(JSON.stringify({ type: "error", code: "roomNotFound" }));
        return;
      }

      if (room.players.length >= 2) {
        ws.send(JSON.stringify({ type: "error", code: "roomFull" }));
        return;
      }

      room.players.push({
        ws,
        id: 2,
        name: String(message.name || "Игрок 2").slice(0, 24),
        ready: false
      });

      ws.roomCode = message.roomCode;
      ws.playerId = 2;

      ws.send(
        JSON.stringify({
          type: "roomJoined",
          roomCode: message.roomCode,
          playerId: 2
        })
      );
      sendRoomUpdate(room);
      console.log(`Игрок зашёл в комнату ${message.roomCode}`);
      return;
    }

    // Готовность игрока
    if (message.type === "setReady") {
      const room = getRoom(ws);
      if (!room) {
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

    // Старт игры (только хост, только когда все готовы)
    if (message.type === "startGame") {
      const room = getRoom(ws);
      if (!room) {
        return;
      }
      if (ws.playerId !== 1) {
        return;
      }
      if (room.players.length !== 2) {
        return;
      }
      if (!room.players.every(p => p.ready)) {
        return;
      }

      room.phase = "game";
      room.turn = 1;
      broadcastToRoom(room, { type: "gameStart" });
      console.log(`Игра началась в комнате ${ws.roomCode}`);
      return;
    }

        // Вежливый выход из комнаты (кнопка в лобби)
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
          // Хост вышел — закрываем комнату для остальных
          for (const player of room.players) {
            if (player.ws && player.ws.readyState === 1) {
              player.ws.send(
                JSON.stringify({ type: "roomClosed", code: "hostLeft" })
              );
            }
          }
          rooms.delete(code);
          console.log(`Комната ${code} закрыта: хост вышел`);
        } else {
          // Второй игрок вышел — хост продолжает ждать
          sendRoomUpdate(room);

          if (room.players.length === 0) {
            rooms.delete(code);
          }
        }
      } else {
        // Выход во время игры = немедленное поражение
        for (const player of room.players) {
          if (player.ws && player.ws.readyState === 1) {
            player.ws.send(JSON.stringify({ type: "opponentLeft" }));
          }
        }
        rooms.delete(code);
      }

      return;
    }

    // Возврат в игру после обрыва соединения
    if (message.type === "rejoinRoom") {
      const room = rooms.get(message.roomCode);

      if (!room || room.phase !== "game") {
        ws.send(JSON.stringify({ type: "gameGone" }));
        return;
      }

      const slot = room.players.find(p => p.id === message.playerId);

      if (!slot || !slot.disconnected) {
        ws.send(JSON.stringify({ type: "gameGone" }));
        return;
      }

      slot.ws = ws;
      slot.disconnected = false;
      ws.roomCode = message.roomCode;
      ws.playerId = message.playerId;

      // ФИКС БАГА 3: возвращаем playerId и roomCode,
      // чтобы клиент восстановил сессию (lobby.js ждёт их в rejoinOk)
      ws.send(JSON.stringify({
        type: "rejoinOk",
        playerId: message.playerId,
        roomCode: message.roomCode
      }));

      // Сообщаем сопернику, что игрок вернулся
      const other = room.players.find(p => p.id !== message.playerId);

      if (other && other.ws && other.ws.readyState === 1) {
        other.ws.send(JSON.stringify({ type: "opponentReconnected" }));
      }

      // Оба на связи — запрашиваем актуальное состояние игры
      if (room.players.every(p => !p.disconnected)) {
        clearTimeout(room.disconnectTimer);
        room.disconnectTimer = null;

        // ФИКС БАГА 1: состояние запрашиваем У СОПЕРНИКА вернувшегося.
        // target — сам вернувшийся, sender — его соперник.
        const target = room.players.find(p => p.id === message.playerId);
        const sender = room.players.find(
          p => p.id !== message.playerId && p.ws && p.ws.readyState === 1
        );

        if (sender && target && target.ws && target.ws.readyState === 1) {
          room.pendingStateFor = target.id;
          sender.ws.send(JSON.stringify({ type: "requestState" }));
        }
      }

      return;
    }

    // Приём полного состояния игры для синхронизации
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
      if (target && target.ws && target.ws.readyState === 1) {
        target.ws.send(JSON.stringify({
          type: "fullState",
          state: message.state
        }));
      }

      room.pendingStateFor = undefined;
      return;
    }

    // Пересылка игровых действий второму игроку
    if (message.type === "gameAction") {
      const room = getRoom(ws);
      if (!room) {
        return;
      }

      // Действия принимаем только во время игры...
      if (room.phase !== "game") {
        return;
      }

      // ...и только от игрока, чей сейчас ход
      if (ws.playerId !== room.turn) {
        return;
      }

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

      // Ход переключается только по корректному endTurn
      if (message.action && message.action.kind === "endTurn") {
        room.turn = room.turn === 1 ? 2 : 1;
      }
      return;
    }
  });

  // Отключение игрока
  ws.on("close", () => {
    console.log("Игрок отключился");

    const code = ws.roomCode;
    const playerId = ws.playerId;
    ws.roomCode = null;

    if (!code) {
      return;
    }

    const room = rooms.get(code);
    if (!room) {
      return;
    }

    // В лобби комнату закрываем сразу (как раньше)
    if (room.phase !== "game") {
      const remaining = room.players.filter(player => player.ws !== ws);
      const leftCode = playerId === 1 ? "hostLeft" : "playerLeft";

      for (const player of remaining) {
        if (player.ws && player.ws.readyState === 1) {
          player.ws.send(JSON.stringify({ type: "roomClosed", code: leftCode }));
        }
      }

      rooms.delete(code);
      console.log(`Комната ${code} закрыта из-за отключения`);
      return;
    }

    // В игре даём игроку шанс вернуться — комната живёт ещё RECONNECT_GRACE_MS
    const slot = room.players.find(p => p.id === playerId);

    // Защита: если слот уже занят новым сокетом (игрок успел вернуться),
    // старый close ничего не ломает
    if (!slot || slot.ws !== ws) {
      return;
    }

    slot.disconnected = true;
    slot.ws = null;

    // Сообщаем сопернику, что ждём возвращения (не победа!)
    const other = room.players.find(p => p.id !== playerId);

    if (other && other.ws && other.ws.readyState === 1) {
      other.ws.send(JSON.stringify({ type: "opponentDisconnected" }));
    }

    clearTimeout(room.disconnectTimer);
    room.disconnectTimer = setTimeout(() => {
      const current = rooms.get(code);
      if (!current) {
        return;
      }

      // Игрок не вернулся — соперник побеждает
      for (const player of current.players) {
        if (player.ws && player.ws.readyState === 1) {
          player.ws.send(JSON.stringify({ type: "opponentLeft" }));
        }
      }

      rooms.delete(code);
      console.log(`Комната ${code} удалена: игрок не вернулся`);
    }, RECONNECT_GRACE_MS);
  });
});