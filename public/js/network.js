// Адрес сервера: тот же, с которого открыта страница
// Работает и локально, и в облаке (ws или wss автоматически)
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const SERVER_URL = `${protocol}//${location.host}`;

let socket = null;

// Список обработчиков сообщений от сервера
const messageHandlers = [];

// Зарегистрировать обработчик сообщений
export function onNetworkMessage(handler) {
  messageHandlers.push(handler);
}

// Подключение к серверу
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
  };

  socket.onerror = (error) => {
    console.error("Ошибка соединения:", error);
  };
}

// Отправка сообщения на сервер
export function sendMessage(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

// Создать комнату
export function createRoom(name) {
  sendMessage({ type: "createRoom", name });
}

// Зайти в комнату
export function joinRoom(code, name) {
  sendMessage({ type: "joinRoom", roomCode: code, name });
}

// Сообщить о готовности
export function setReady(ready) {
  sendMessage({ type: "setReady", ready });
}

// Запросить старт игры
export function startGame() {
  sendMessage({ type: "startGame" });
}

connectToServer();