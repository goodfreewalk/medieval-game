// Адрес сервера: тот же, с которого открыта страница
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const SERVER_URL = `${protocol}//${location.host}`;

let socket = null;
const messageHandlers = [];
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// Сессия игры для возврата после обрыва соединения (по вкладка жива)
const GAME_SESSION_KEY = "gameSession";

export function saveGameSession(roomCode, playerId) {
  try {
    sessionStorage.setItem(
      GAME_SESSION_KEY,
      JSON.stringify({ roomCode, playerId })
    );
  } catch {
    // sessionStorage может быть недоступен — не критично
  }
}

export function clearGameSession() {
  try {
    sessionStorage.removeItem(GAME_SESSION_KEY);
  } catch {
    // ignore
  }
}

function getGameSession() {
  try {
    return JSON.parse(sessionStorage.getItem(GAME_SESSION_KEY));
  } catch {
    return null;
  }
}

export function onNetworkMessage(handler) {
  messageHandlers.push(handler);
}

function dispatch(message) {
  for (const handler of messageHandlers) {
    handler(message);
  }
}

function connectToServer() {
  socket = new WebSocket(SERVER_URL);

  socket.onopen = () => {
    console.log("Подключено к серверу");
    reconnectAttempts = 0;

    // Есть сохранённая сессия — пытаемся вернуться в игру
    const session = getGameSession();

    if (session) {
      sendMessage({
        type: "rejoinRoom",
        roomCode: session.roomCode,
        playerId: session.playerId
      });
    }
  };

  socket.onmessage = (event) => {
    let message;

    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    dispatch(message);
  };

  socket.onclose = () => {
    console.log("Соединение закрыто");

    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts += 1;
      const delay = Math.min(5000, 500 * reconnectAttempts);
      dispatch({ type: "reconnecting", attempt: reconnectAttempts });
      setTimeout(connectToServer, delay);
    } else {
      dispatch({ type: "connectionLost" });
    }
  };

  socket.onerror = (error) => {
    console.error("Ошибка соединения:", error);
  };
}

export function sendMessage(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

export function createRoom(name) {
  sendMessage({ type: "createRoom", name });
}

// preferredSeat — заявка на место (карточка сохранения, возврат владельца)
export function joinRoom(code, name, preferredSeat = null) {
  sendMessage({ type: "joinRoom", roomCode: code, name, preferredSeat });
}

export function setReady(ready) {
  sendMessage({ type: "setReady", ready });
}

export function startGame() {
  sendMessage({ type: "startGame" });
}

// Вежливый выход из комнаты/лобби
export function leaveRoom() {
  sendMessage({ type: "leaveRoom" });
}

connectToServer();