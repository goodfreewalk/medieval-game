import { MAP_SIZE, TERRAIN, TERRAIN_COST } from "./terrain.js";
import { createInitialUnits } from "./units.js";

export const state = {
  canvas: null,
  ctx: null,
  tileSize: 0,
  map: null,
  units: [],
  currentPlayer: 1,
  selectedTile: null,
  selectedUnit: null,
  reachableTiles: new Map(),
  attackableTiles: new Map(),
  owners: new Map(),
  players: {},
  gameOver: false,
  winner: null
};

export function tileKey(x, y) {
  return `${x},${y}`;
}

export function createMap() {
  const map = [];

  // Заполняем всю карту травой
  for (let y = 0; y < MAP_SIZE; y++) {
    const row = [];

    for (let x = 0; x < MAP_SIZE; x++) {
      row.push(TERRAIN.GRASS);
    }

    map.push(row);
  }

  // Лес
  map[3][5] = TERRAIN.FOREST;
  map[3][6] = TERRAIN.FOREST;
  map[4][5] = TERRAIN.FOREST;
  map[4][6] = TERRAIN.FOREST;

  map[10][9] = TERRAIN.FOREST;
  map[10][10] = TERRAIN.FOREST;
  map[11][9] = TERRAIN.FOREST;
  map[11][10] = TERRAIN.FOREST;

  // Холмы
  map[7][4] = TERRAIN.HILL;
  map[7][5] = TERRAIN.HILL;
  map[8][10] = TERRAIN.HILL;
  map[8][11] = TERRAIN.HILL;

  // Река
  for (let y = 5; y < 11; y++) {
    map[y][8] = TERRAIN.WATER;
  }

  // Горы
  map[12][3] = TERRAIN.MOUNTAIN;
  map[12][4] = TERRAIN.MOUNTAIN;
  map[3][11] = TERRAIN.MOUNTAIN;
  map[3][12] = TERRAIN.MOUNTAIN;

  // Игрок 1: замок и деревни
  map[2][2] = TERRAIN.CASTLE;
  map[2][3] = TERRAIN.VILLAGE;
  map[3][2] = TERRAIN.VILLAGE;

  // Игрок 2: замок и деревни
  map[13][13] = TERRAIN.CASTLE;
  map[13][12] = TERRAIN.VILLAGE;
  map[12][13] = TERRAIN.VILLAGE;

  // Нейтральные объекты
  map[5][12] = TERRAIN.VILLAGE;
  map[10][3] = TERRAIN.VILLAGE;
  map[6][6] = TERRAIN.CASTLE;
  map[9][9] = TERRAIN.CASTLE;

  return map;
}

export function setTileOwner(x, y, owner) {
  state.owners.set(tileKey(x, y), owner);
}

export function initializeOwners() {
  state.owners = new Map();

  // Сначала все деревни и замки нейтральны
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const terrain = state.map[y][x];

      if (terrain === TERRAIN.VILLAGE || terrain === TERRAIN.CASTLE) {
        setTileOwner(x, y, 0);
      }
    }
  }

  // Стартовые территории игрока 1
  setTileOwner(2, 2, 1);
  setTileOwner(2, 3, 1);
  setTileOwner(3, 2, 1);

  // Стартовые территории игрока 2
  setTileOwner(13, 13, 2);
  setTileOwner(13, 12, 2);
  setTileOwner(12, 13, 2);
}

export function initGame(canvas, ctx) {
  state.canvas = canvas;
  state.ctx = ctx;
  state.tileSize = canvas.width / MAP_SIZE;
  state.map = createMap();
  initializeOwners();
  state.units = createInitialUnits();

  state.players = {
    1: {
      gold: 40
    },
    2: {
      gold: 40
    }
  };

  state.gameOver = false;
  state.winner = null;
  state.currentPlayer = 1;
  state.selectedTile = null;
  state.selectedUnit = null;
  state.reachableTiles = new Map();
  state.attackableTiles = new Map();
}

export function getTerrainAt(x, y) {
  return state.map[y][x];
}

export function getTileOwner(x, y) {
  return state.owners.get(tileKey(x, y)) || 0;
}

export function captureTile(unit) {
  const terrain = getTerrainAt(unit.x, unit.y);

  if (terrain !== TERRAIN.VILLAGE && terrain !== TERRAIN.CASTLE) {
    return false;
  }

  const currentOwner = getTileOwner(unit.x, unit.y);

  if (currentOwner === unit.owner) {
    return false;
  }

  setTileOwner(unit.x, unit.y, unit.owner);
  return true;
}

export function isTileBlockedByUnit(x, y, ignoreUnit = null) {
  return state.units.some(
    unit => unit !== ignoreUnit && unit.x === x && unit.y === y
  );
}

export function isTilePassable(x, y, ignoreUnit = null) {
  const terrain = getTerrainAt(x, y);
  const cost = TERRAIN_COST[terrain];

  if (cost === Infinity) {
    return false;
  }

  if (isTileBlockedByUnit(x, y, ignoreUnit)) {
    return false;
  }

  return true;
}

// Экономика

function getOwnedTerritories(owner) {
  let castles = 0;
  let villages = 0;

  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const tileOwner = getTileOwner(x, y);

      if (tileOwner !== owner) {
        continue;
      }

      const terrain = state.map[y][x];

      if (terrain === TERRAIN.CASTLE) {
        castles++;
      }

      if (terrain === TERRAIN.VILLAGE) {
        villages++;
      }
    }
  }

  return {
    castles,
    villages
  };
}

export function getPlayerGold(owner) {
  return state.players[owner]?.gold || 0;
}

export function getIncome(owner) {
  const owned = getOwnedTerritories(owner);

  return owned.castles * 6 + owned.villages * 2;
}

export function getSupplyCapacity(owner) {
  const owned = getOwnedTerritories(owner);

  return owned.castles * 3 + owned.villages * 1;
}

export function getSupplyUsed(owner) {
  return state.units.filter(unit => unit.owner === owner).length;
}

export function collectIncome(owner) {
  state.players[owner].gold += getIncome(owner);
}