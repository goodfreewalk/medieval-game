import { TERRAIN } from "./terrain.js";
import { createInitialUnits } from "./units.js";
import { getMapById, parseMap } from "./maps.js";

// Мировой размер клетки в условных пикселях.
// Камера (zoom/pan) масштабирует мир при отрисовке, поэтому
// размер canvas больше не влияет на игровую математику.
export const WORLD_TILE = 64;

export const state = {
  canvas: null,
  ctx: null,

  // Параметры экрана (выставляет main.js при ресайзе/старте)
  viewW: 0,
  viewH: 0,
  dpr: 1,

  // Камера: смещение в экранных px и масштаб
  panX: 0,
  panY: 0,
  zoom: 1,

  // Мир
  tileSize: WORLD_TILE,
  map: null,
  units: [],
  currentPlayer: 1,
  selectedTile: null,
  selectedUnit: null,
  reachableTiles: new Map(),
  attackableTiles: new Map(),
  owners: new Map(),
  players: {},

  // Реестр устранённых мест (не участвуют в очерёдности и победе)
  eliminated: new Set(),
  // Виды мест в текущей партии: { id: "human" | "passive" | "bot" }
  seatKinds: {},
  // Отношения соперников к нам: { otherId: score } (приходит с сервера)
  relations: {},

  gameOver: false,
  winner: null
};

export function tileKey(x, y) {
  return `${x},${y}`;
}

export function setTileOwner(x, y, owner) {
  state.owners.set(tileKey(x, y), owner);
}

// options: { mapId, seats } — seats = массив id игроков (например [1,2] или [1,2,3,4])
export function initGame(canvas, ctx, options = {}) {
  const mapDef = getMapById(options.mapId);
  const parsed = parseMap(mapDef);
  const seats = Array.isArray(options.seats) && options.seats.length > 0
    ? options.seats.slice().sort((a, b) => a - b)
    : [1, 2];

  state.canvas = canvas;
  state.ctx = ctx;
  state.map = parsed.terrain;
  state.tileSize = WORLD_TILE;

  // Владельцы зданий: стартовые наборы отсутствующих игроков становятся нейтральными
  state.owners = new Map();

  for (let y = 0; y < parsed.size; y++) {
    for (let x = 0; x < parsed.size; x++) {
      const terrain = parsed.terrain[y][x];

      if (terrain === TERRAIN.VILLAGE || terrain === TERRAIN.CASTLE) {
        setTileOwner(x, y, 0);
      }
    }
  }

  for (const entry of parsed.owners) {
    const owner = seats.includes(entry.owner) ? entry.owner : 0;
    setTileOwner(entry.x, entry.y, owner);
  }

  // Игроки и экономика
  state.players = {};

  for (const id of seats) {
    state.players[id] = { gold: 40 };
  }

  state.units = createInitialUnits(parsed.starts, seats, parsed.terrain);

  state.gameOver = false;
  state.winner = null;
  state.eliminated = new Set();
  state.seatKinds = {};

  for (const id of seats) {
    state.seatKinds[id] = "human";
  }

  state.currentPlayer = 1;
  state.selectedTile = null;
  state.selectedUnit = null;
  state.reachableTiles = new Map();
  state.attackableTiles = new Map();

  // Симметрия первого хода: все получают доход до старта
  for (const id of seats) {
    collectIncome(id);
  }
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

// Экономика
function getOwnedTerritories(owner) {
  let castles = 0;
  let villages = 0;
  const size = state.map.length;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const owner_ = getTileOwner(x, y);

      if (owner_ !== owner) {
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

  return { castles, villages };
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

// Регенерация в начале своего хода на СОБСТВЕННЫХ зданиях:
//   спокойно:    замок +10, деревня +5
//   под осаде:   замок +5,  деревня +2  (юнит терял HP с прошлого своего хода)
const REGEN_CASTLE = 10;
const REGEN_VILLAGE = 5;
const REGEN_CASTLE_SIEGE = 5;
const REGEN_VILLAGE_SIEGE = 2;

function applyRegeneration(owner) {
  if (!state.map) {
    return;
  }

  for (const unit of state.units) {
    if (unit.owner !== owner) {
      continue;
    }

    const terrain = state.map[unit.y][unit.x];

    if (terrain !== TERRAIN.CASTLE && terrain !== TERRAIN.VILLAGE) {
      continue;
    }

    if (getTileOwner(unit.x, unit.y) !== owner) {
      continue;
    }

    const siege = !!unit.lastHit;
    const heal = terrain === TERRAIN.CASTLE
      ? (siege ? REGEN_CASTLE_SIEGE : REGEN_CASTLE)
      : (siege ? REGEN_VILLAGE_SIEGE : REGEN_VILLAGE);
    const cap = unit.maxHp || 100;

    if (unit.hp < cap) {
      unit.hp = Math.min(cap, unit.hp + heal);
    }

    // Флаг «под обстрелом» живёт ровно до начала своего хода
    unit.lastHit = false;
  }
}

export function collectIncome(owner) {
  state.players[owner].gold += getIncome(owner);
  applyRegeneration(owner);
}

// Полный сброс клиентского состояния (выход в меню без перезагрузки)
export function resetState() {
  state.map = null;
  state.units = [];
  state.players = {};
  state.owners = new Map();
  state.eliminated = new Set();
  state.seatKinds = {};
  state.relations = {};
  state.currentPlayer = 1;
  state.selectedTile = null;
  state.selectedUnit = null;
  state.reachableTiles = new Map();
  state.attackableTiles = new Map();
  state.gameOver = false;
  state.winner = null;
  state.panX = 0;
  state.panY = 0;
  state.zoom = 1;
}