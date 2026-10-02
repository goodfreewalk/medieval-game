import { TERRAIN_COST } from "./terrain.js";

// Цвета игроков (1-4): для партий на 2, 3 и 4 игрока
export const PLAYER_COLORS = {
  1: "#2f7ef7",
  2: "#e5484d",
  3: "#3dbb4a",
  4: "#e08a1e"
};

export const UNIT_TYPES = {
  militia: {
    cost: 15,
    movement: 3,
    attack: 20,
    defense: 36,
    range: 1
  },
  archer: {
    cost: 30,
    movement: 3,
    attack: 26,
    defense: 28,
    range: 2
  },
  swordsman: {
    cost: 40,
    movement: 3,
    attack: 30,
    defense: 44,
    range: 1
  },
  lightCavalry: {
    cost: 45,
    movement: 5,
    attack: 28,
    defense: 36,
    range: 1
  },
  heavyCavalry: {
    cost: 75,
    movement: 4,
    attack: 36,
    defense: 60,
    range: 1
  },
  horseArcher: {
    cost: 60,
    movement: 5,
    attack: 26,
    defense: 34,
    range: 2
  }
};

// ready = true — юнит может действовать в этот ход;
// ready = false — «уставший» (нанятые оживают в свой следующий ход)
export function createUnit(id, type, owner, x, y, ready = true) {
  return {
    id,
    type,
    owner,
    x,
    y,
    hp: 100,
    hasAttacked: !ready,
    movementLeft: ready ? UNIT_TYPES[type].movement : 0
  };
}

// Стартовые юниты для больших карт и любого числа игроков.
// starts — { playerId: { x, y } } (замки из карты),
// seats — массив id игроков в партии (например [1, 2] или [1, 2, 3, 4]),
// terrain — двумерный массив местности (проверка проходимости клеток)
export function createInitialUnits(starts, seats, terrain) {
  const units = [];
  let nextId = 1;

  // Клетки вокруг замка, куда сажаем бойцов (по приоритету)
  const offsets = [
    { x: 0, y: 1 },
    { x: 1, y: 1 },
    { x: 1, y: 0 },
    { x: 0, y: -1 },
    { x: -1, y: -1 },
    { x: -1, y: 0 },
    { x: 1, y: -1 },
    { x: -1, y: 1 }
  ];

  const types = ["militia", "archer", "swordsman"];

  for (const playerId of seats) {
    const start = starts[playerId];

    if (!start) {
      continue;
    }

    for (const type of types) {
      for (const off of offsets) {
        const x = start.x + off.x;
        const y = start.y + off.y;

        // Не выходим за край карты
        if (y < 0 || y >= terrain.length || x < 0 || x >= terrain.length) {
          continue;
        }

        // Не ставим на воду и горы
        if (TERRAIN_COST[terrain[y][x]] === Infinity) {
          continue;
        }

        // Не ставим двух юнитов на одну клетку
        if (units.some(u => u.x === x && u.y === y)) {
          continue;
        }

        // Стартовые юниты активны сразу (ready = true)
        units.push(createUnit(nextId, type, playerId, x, y, true));
        nextId += 1;
        break;
      }
    }
  }

  return units;
}

export function getUnitAtTile(units, x, y) {
  return units.find(unit => unit.x === x && unit.y === y) || null;
}

export function getDistance(unitA, unitB) {
  return Math.abs(unitA.x - unitB.x) + Math.abs(unitA.y - unitB.y);
}