// Адрес сервера: тот же, с которого открыта страница
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const SERVER_URL = `${protocol}//${location.host}`;

let socket = null;
const messageHandlers = [];
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

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
  };

  socket.onmessage = (event) => {
    // Некорректное сообщение не должно ломать обработку
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
      // Сдаёмся: сообщаем интерфейсу, что соединение потеряно
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

export function joinRoom(code, name) {
  sendMessage({ type: "joinRoom", roomCode: code, name });
}

export function setReady(ready) {
  sendMessage({ type: "setReady", ready });
}

export function startGame() {
  sendMessage({ type: "startGame" });
}

connectToServer();
