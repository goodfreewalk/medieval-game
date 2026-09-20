const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;

const app = express();

// Раздаём файлы клиента из папки public
app.use(express.static(path.join(__dirname, "..", "public")));

// Запускаем HTTP-сервер
const httpServer = app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log(`Открой в браузере: http://localhost:${PORT}`);
});

// WebSocket на том же сервере и порту
const wss = new WebSocketServer({ server: httpServer });

console.log("WebSocket готов");

// Список комнат: код комнаты -> { players: [...], phase: "lobby" | "game" }
const rooms = new Map();

// Генерируем короткий код комнаты, например "K7QF"
function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  if (rooms.has(code)) {
    return generateRoomCode();
  }

  return code;
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

wss.on("connection", (ws) => {
  console.log("Игрок подключился");

  ws.roomCode = null;
  ws.playerId = null;

  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());

    // Создание комнаты
    if (message.type === "createRoom") {
      const code = generateRoomCode();
      const room = { players: [], phase: "lobby" };

      rooms.set(code, room);

      room.players.push({
        ws,
        id: 1,
        name: message.name || "Игрок 1",
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
        name: message.name || "Игрок 2",
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
    }

    // Готовность игрока
    if (message.type === "setReady") {
      if (!ws.roomCode) {
        return;
      }

      const room = rooms.get(ws.roomCode);
      const player = room.players.find(p => p.ws === ws);

      if (!player) {
        return;
      }

      player.ready = !!message.ready;

      sendRoomUpdate(room);
    }

    // Старт игры (только хост, только когда все готовы)
    if (message.type === "startGame") {
      if (!ws.roomCode) {
        return;
      }

      const room = rooms.get(ws.roomCode);

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

      broadcastToRoom(room, { type: "gameStart" });

      console.log(`Игра началась в комнате ${ws.roomCode}`);
    }

    // Пересылка игровых действий второму игроку
    if (message.type === "gameAction") {
      if (!ws.roomCode) {
        return;
      }

      const room = rooms.get(ws.roomCode);

      if (!room) {
        return;
      }

      const text = JSON.stringify(message);

      for (const player of room.players) {
        if (player.ws !== ws && player.ws.readyState === 1) {
          player.ws.send(text);
        }
      }
    }
  });

  // Отключение игрока
  ws.on("close", () => {
    console.log("Игрок отключился");

    if (!ws.roomCode) {
      return;
    }

    const room = rooms.get(ws.roomCode);

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
      const code = ws.playerId === 1 ? "hostLeft" : "playerLeft";

      for (const player of remaining) {
        if (player.ws.readyState === 1) {
          player.ws.send(JSON.stringify({ type: "roomClosed", code }));
        }
      }
    }

    rooms.delete(ws.roomCode);

    console.log(`Комната ${ws.roomCode} закрыта из-за отключения`);

    ws.roomCode = null;
  });
});