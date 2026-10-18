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

// Стартовые юниты: смещения зеркалятся относительно центра карты,
// чтобы тройка всех игроков появлялась со стороны ЦЕНТРА от замка.
// Без зеркальности правые/нижние игроки получали фору или штраф
// в несколько клеток хода (замечено: 4 / 5 / 7 ходов до нейтралей).
export function createInitialUnits(starts, seats, terrain) {
  const units = [];
  let nextId = 1;
  const size = terrain.length;

  for (const start of starts) {
    if (!seats.includes(start.owner)) {
      continue;
    }

    const sx = start.x < size / 2 ? 1 : -1;
    const sy = start.y < size / 2 ? 1 : -1;

    const offsets = [
      { dx: sx, dy: 0, type: "swordsman" },
      { dx: 0, dy: sy, type: "militia" },
      { dx: sx, dy: sy, type: "archer" }
    ];

    for (const off of offsets) {
      const x = start.x + off.dx;
      const y = start.y + off.dy;

      if (x < 0 || y < 0 || x >= size || y >= size) {
        continue;
      }

      if (units.some(u => u.x === x && u.y === y)) {
        continue;
      }

      const unit = createUnit(nextId, off.type, start.owner, x, y, false);

      // Юнит рождается «свежим»: createUnit по умолчанию создаёт
      // уставшего (освежение обычно происходит передачей хода,
      // но у первого игрока её нет — без этого сброса его юниты
      // стояли полупрозрачными и не могли ходить на 1-м ходу)
      unit.hasAttacked = false;
      unit.movementLeft = UNIT_TYPES[off.type].movement;

      units.push(unit);
      nextId += 1;
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