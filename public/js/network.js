// Адрес сервера: тот же, с которого открыта страница
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const SERVER_URL = `${protocol}//${location.host}`;

let socket = null;
const messageHandlers = [];

export function onNetworkMessage(handler) {
  messageHandlers.push(handler);
}

function connectToServer() {
  socket = new WebSocket(SERVER_URL);

  socket.onopen = () => {
    console.log("Подключено к серверу");
  };

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);

    for (const handler of messageHandlers) {
      handler(message);
    }
  };

  socket.onclose = () => {
    console.log("Соединение закрыто");
    
    // Если соединение закрыто не нами — уведомляем об выходе соперника
    for (const handler of messageHandlers) {
      handler({ type: "opponentLeft" });
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