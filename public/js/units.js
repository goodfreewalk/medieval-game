export const PLAYER_COLORS = {
  1: "#2f7ef7",
  2: "#e5484d"
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

export function createInitialUnits() {
  return [
    // Игрок 1
    createUnit(1, "militia", 1, 2, 3, true),
    createUnit(2, "archer", 1, 3, 3, true),
    createUnit(3, "swordsman", 1, 3, 4, true),
    // Игрок 2
    createUnit(4, "militia", 2, 13, 12, true),
    createUnit(5, "archer", 2, 12, 12, true),
    createUnit(6, "swordsman", 2, 12, 11, true)
  ];
}

export function getUnitAtTile(units, x, y) {
  return units.find(unit => unit.x === x && unit.y === y) || null;
}

export function getDistance(unitA, unitB) {
  return Math.abs(unitA.x - unitB.x) + Math.abs(unitA.y - unitB.y);
}