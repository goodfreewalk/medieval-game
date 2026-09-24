import { TERRAIN_KEYS } from "./terrain.js";

const translations = {
  ru: {
    title: "Средневековая стратегия",
    infoDefault: "Кликни по клетке",
    cell: "Клетка",
    type: "Тип",
    unitLabel: "Юнит",
    player: "Игрок",
    health: "Здоровье",
    movement: "Движение",
    currentPlayer: "Ход игрока",
    endTurn: "Завершить ход",
    ready: "Готов",
    moved: "Двигался",
    acted: "Действовал",
    damage: "Урон",
    counter: "Контратака",
    destroyed: "Уничтожен",
    attackerLost: "Атакующий потерян",
    defenderLost: "Защитник потерян",
    captured: "Территория захвачена",
    gold: "Золото",
    income: "Доход",
    supply: "Снабжение",
    recruit: "Найм",
    recruited: "Юнит нанят",
    needGold: "Недостаточно золота",
    needSupply: "Недостаточно снабжения",
    castleOccupied: "Клетка занята",
    notCastle: "Это не ваше здание",
    notAllowedHere: "Недоступно здесь",
    gameOver: "Игра окончена",
    wins: "победил!",
    draw: "Ничья!",
    playAgain: "Играть снова",
    eliminated: "выбыл",
    defenseBonus: "Защита",
    moveCost: "Движение",
    terrainInfo: "Бонусы местности",
    menuTitle: "Средневековая стратегия",
    nickname: "Имя игрока",
    createRoom: "Создать комнату",
    join: "Войти",
    roomCodePlaceholder: "Код комнаты",
    lobbyTitle: "Лобби",
    roomLabel: "Код комнаты",
    playersLabel: "Игроки",
    cancelReady: "Не готов",
    startGame: "Начать игру",
    waitingPlayers: "Ожидание игроков…",
    waitingReady: "Ожидание готовности…",
    waitingHost: "Хост начинает игру…",
    canStart: "Можно начинать!",
    playerReady: "готов",
    playerNotReady: "не готов",
    youMark: "(ты)",
    roomNotFound: "Комната не найдена",
    roomFull: "Комната заполнена",
    enterCode: "Введите код комнаты",
    opponentLeft: "Противник покинул игру",
    hostLeft: "Хост покинул комнату",
    playerLeft: "Игрок покинул комнату",
    // ФИКС: ключи, которых не хватало (использовались в main.js)
    turn: "Ход",
    yourTurn: "Твой ход",
    victory: "Победа!",
    defeat: "Поражение",
    connectionLost: "Соединение с сервером потеряно. Обновите страницу.",
    reconnecting: "Переподключение…",
    terrain: {
      grass: "Равнина",
      forest: "Лес",
      hill: "Холм",
      water: "Вода",
      mountain: "Гора",
      village: "Деревня",
      castle: "Замок"
    },
    unit: {
      militia: "Ополченец",
      archer: "Лучник",
      swordsman: "Мечник",
      lightCavalry: "Лёгкая конница",
      heavyCavalry: "Тяжёлая конница",
      horseArcher: "Конные лучники"
    }
  },
  en: {
    title: "Medieval Strategy",
    infoDefault: "Click a tile",
    cell: "Tile",
    type: "Type",
    unitLabel: "Unit",
    player: "Player",
    health: "Health",
    movement: "Movement",
    currentPlayer: "Turn of Player",
    endTurn: "End Turn",
    ready: "Ready",
    moved: "Moved",
    acted: "Acted",
    damage: "Damage",
    counter: "Counterattack",
    destroyed: "Destroyed",
    attackerLost: "Attacker lost",
    defenderLost: "Defender lost",
    captured: "Territory captured",
    gold: "Gold",
    income: "Income",
    supply: "Supply",
    recruit: "Recruit",
    recruited: "Unit recruited",
    needGold: "Not enough gold",
    needSupply: "Not enough supply",
    castleOccupied: "Tile is occupied",
    notCastle: "This is not your building",
    notAllowedHere: "Not available here",
    gameOver: "Game Over",
    wins: "wins!",
    draw: "Draw!",
    playAgain: "Play Again",
    eliminated: "has been eliminated",
    defenseBonus: "Defense",
    moveCost: "Movement",
    terrainInfo: "Terrain bonuses",
    menuTitle: "Medieval Strategy",
    nickname: "Player name",
    createRoom: "Create room",
    join: "Join",
    roomCodePlaceholder: "Room code",
    lobbyTitle: "Lobby",
    roomLabel: "Room code",
    playersLabel: "Players",
    cancelReady: "Not ready",
    startGame: "Start game",
    waitingPlayers: "Waiting for players…",
    waitingReady: "Waiting for players to be ready…",
    waitingHost: "Host is starting the game…",
    canStart: "Ready to start!",
    playerReady: "ready",
    playerNotReady: "not ready",
    youMark: "(you)",
    roomNotFound: "Room not found",
    roomFull: "Room is full",
    enterCode: "Enter the room code",
    opponentLeft: "Opponent left the game",
    hostLeft: "Host left the room",
    playerLeft: "Player left the room",
    // FIX: keys used in main.js were missing
    turn: "Turn",
    yourTurn: "Your turn",
    victory: "Victory!",
    defeat: "Defeat",
    connectionLost: "Connection to the server lost. Please reload the page.",
    reconnecting: "Reconnecting…",
    terrain: {
      grass: "Plains",
      forest: "Forest",
      hill: "Hill",
      water: "Water",
      mountain: "Mountain",
      village: "Village",
      castle: "Castle"
    },
    unit: {
      militia: "Militia",
      archer: "Archer",
      swordsman: "Swordsman",
      lightCavalry: "Light Cavalry",
      heavyCavalry: "Heavy Cavalry",
      horseArcher: "Horse Archer"
    }
  }
};

let language = localStorage.getItem("gameLanguage") || "ru";

export function getLanguage() {
  return language;
}

export function setLanguage(newLanguage) {
  language = newLanguage;
  localStorage.setItem("gameLanguage", language);
}

export function t(key) {
  return translations[language][key] || key;
}

export function terrainName(terrain) {
  const key = TERRAIN_KEYS[terrain];
  return translations[language].terrain[key] || key;
}

export function unitName(type) {
  return translations[language].unit[type] || type;
}
