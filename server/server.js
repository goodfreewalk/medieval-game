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

// Список комнат: код комнаты -> { players, phase, turn }
const rooms = new Map();

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
    if (player.ws.readyState === 1) {
      player.ws.send(text);
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

wss.on("connection", (ws) => {
  console.log("Игрок подключился");

  ws.roomCode = null;
  ws.playerId = null;
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
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
        if (player.ws !== ws && player.ws.readyState === 1) {
          player.ws.send(text);
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
    ws.roomCode = null;

    if (!code) {
      return;
    }

    const room = rooms.get(code);

    if (!room) {
      return;
    }

    const remaining = room.players.filter(player => player.ws !== ws);

    // Если игра уже шла — второй игрок побеждает
    if (room.phase === "game") {
      for (const player of remaining) {
        if (player.ws.readyState === 1) {
          player.ws.send(JSON.stringify({ type: "opponentLeft" }));
        }
      }
    } else {
      // Если были в лобби — комната закрывается
      const leftCode = ws.playerId === 1 ? "hostLeft" : "playerLeft";

      for (const player of remaining) {
        if (player.ws.readyState === 1) {
          player.ws.send(JSON.stringify({ type: "roomClosed", code: leftCode }));
        }
      }
    }

    rooms.delete(code);

    console.log(`Комната ${code} закрыта из-за отключения`);
  });
});
