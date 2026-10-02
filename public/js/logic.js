import {
  TERRAIN,
  TERRAIN_COST,
  TERRAIN_DEFENSE
} from "./terrain.js";
import {
  UNIT_TYPES,
  getDistance,
  getUnitAtTile,
  createUnit
} from "./units.js";
import {
  state,
  getTerrainAt,
  captureTile,
  collectIncome,
  getTileOwner,
  getPlayerGold,
  getSupplyUsed,
  getSupplyCapacity
} from "./state.js";

export function getReachableTiles(unit) {
  const reachable = new Map();
  const movement = unit.movementLeft;
  const size = state.map.length;

  if (movement <= 0) {
    return reachable;
  }

  const directions = [
    { x: 0, y: -1 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
    { x: 1, y: 0 }
  ];

  const queue = [
    {
      x: unit.x,
      y: unit.y,
      cost: 0
    }
  ];

  const bestCost = new Map();
  const startKey = `${unit.x},${unit.y}`;
  bestCost.set(startKey, 0);

  while (queue.length > 0) {
    const current = queue.shift();

    for (const dir of directions) {
      const nextX = current.x + dir.x;
      const nextY = current.y + dir.y;

      if (nextX < 0 || nextX >= size || nextY < 0 || nextY >= size) {
        continue;
      }

      const terrain = getTerrainAt(nextX, nextY);
      const terrainCost = TERRAIN_COST[terrain];

      if (terrainCost === Infinity) {
        continue;
      }

      const occupant = getUnitAtTile(state.units, nextX, nextY);

      if (occupant && occupant.owner !== unit.owner) {
        continue;
      }

      const newCost = current.cost + terrainCost;

      if (newCost > movement) {
        continue;
      }

      const key = `${nextX},${nextY}`;
      const previousCost = bestCost.get(key);

      if (previousCost === undefined || newCost < previousCost) {
        bestCost.set(key, newCost);

        if (!occupant) {
          reachable.set(key, {
            x: nextX,
            y: nextY,
            cost: newCost
          });
        }

        queue.push({
          x: nextX,
          y: nextY,
          cost: newCost
        });
      }
    }
  }

  return reachable;
}

export function getAttackableTiles(unit) {
  const result = new Map();

  if (unit.owner !== state.currentPlayer) {
    return result;
  }

  if (unit.hasAttacked) {
    return result;
  }

  const range = UNIT_TYPES[unit.type].range;

  for (const enemy of state.units) {
    if (enemy.owner === unit.owner) {
      continue;
    }

    if (getDistance(unit, enemy) <= range) {
      const key = `${enemy.x},${enemy.y}`;
      result.set(key, {
        x: enemy.x,
        y: enemy.y
      });
    }
  }

  return result;
}

export function updateSelectionHighlights() {
  if (!state.selectedUnit) {
    state.reachableTiles = new Map();
    state.attackableTiles = new Map();
    return;
  }

  if (state.selectedUnit.owner !== state.currentPlayer) {
    state.reachableTiles = new Map();
    state.attackableTiles = new Map();
    return;
  }

  if (
    !state.selectedUnit.hasAttacked &&
    state.selectedUnit.movementLeft > 0
  ) {
    state.reachableTiles = getReachableTiles(state.selectedUnit);
  } else {
    state.reachableTiles = new Map();
  }

  if (!state.selectedUnit.hasAttacked) {
    state.attackableTiles = getAttackableTiles(state.selectedUnit);
  } else {
    state.attackableTiles = new Map();
  }
}

export function canAttackUnit(attacker, target) {
  if (!attacker) {
    return false;
  }

  if (!target) {
    return false;
  }

  if (attacker.owner !== state.currentPlayer) {
    return false;
  }

  if (attacker.hasAttacked) {
    return false;
  }

  if (attacker.owner === target.owner) {
    return false;
  }

  const range = UNIT_TYPES[attacker.type].range;

  return getDistance(attacker, target) <= range;
}

export function calculateDamage(attacker, defender) {
  const attackPower =
    UNIT_TYPES[attacker.type].attack * (Math.max(0, attacker.hp) / 100);

  const terrain = getTerrainAt(defender.x, defender.y);
  const terrainDefense = TERRAIN_DEFENSE[terrain] || 0;
  const defense = UNIT_TYPES[defender.type].defense + terrainDefense;

  if (defense <= 0) {
    return 100;
  }

  const ratio = attackPower / defense;
  const damage = Math.round(100 * ratio * ratio);

  return Math.min(100, damage);
}

export function performAttack(attacker, defender) {
  const damageToDefender = calculateDamage(attacker, defender);

  defender.hp = Math.max(0, defender.hp - damageToDefender);

  const defenderDestroyed = defender.hp <= 0;

  let damageToAttacker = 0;
  let attackerDestroyed = false;

  const canCounter =
    !defenderDestroyed &&
    getDistance(attacker, defender) <= UNIT_TYPES[defender.type].range;

  if (canCounter) {
    damageToAttacker = calculateDamage(defender, attacker);
    attacker.hp = Math.max(0, attacker.hp - damageToAttacker);
    attackerDestroyed = attacker.hp <= 0;
  }

  if (defenderDestroyed) {
    state.units = state.units.filter(unit => unit !== defender);
  }

  if (attackerDestroyed) {
    state.units = state.units.filter(unit => unit !== attacker);
  }

  if (!attackerDestroyed) {
    attacker.hasAttacked = true;
    attacker.movementLeft = 0;

    if (
      defenderDestroyed &&
      UNIT_TYPES[attacker.type].range === 1
    ) {
      attacker.x = defender.x;
      attacker.y = defender.y;
    }
  }

  return {
    damageToDefender,
    damageToAttacker,
    defenderDestroyed,
    attackerDestroyed
  };
}

export function applyMove(unitId, x, y) {
  const unit = state.units.find(u => u.id === unitId);

  if (!unit) {
    return { success: false };
  }

  if (unit.owner !== state.currentPlayer) {
    return { success: false };
  }

  if (unit.hasAttacked || unit.movementLeft <= 0) {
    return { success: false };
  }

  const reachable = getReachableTiles(unit);
  const target = reachable.get(`${x},${y}`);

  if (!target) {
    return { success: false };
  }

  unit.x = x;
  unit.y = y;
  unit.movementLeft = Math.max(0, unit.movementLeft - target.cost);

  return { success: true };
}

export function applyAttack(attackerId, targetId) {
  const attacker = state.units.find(u => u.id === attackerId);
  const defender = state.units.find(u => u.id === targetId);

  if (!attacker || !defender) {
    return { success: false };
  }

  if (!canAttackUnit(attacker, defender)) {
    return { success: false };
  }

  const result = performAttack(attacker, defender);

  checkEliminationAndVictory();

  return {
    success: true,
    ...result
  };
}

export function applyRecruit(type, x, y) {
  if (!UNIT_TYPES[type]) {
    return { success: false };
  }

  const terrain = getTerrainAt(x, y);

  if (terrain !== TERRAIN.CASTLE && terrain !== TERRAIN.VILLAGE) {
    return { success: false };
  }

  const owner = getTileOwner(x, y);

  if (owner !== state.currentPlayer) {
    return { success: false };
  }

  if (terrain === TERRAIN.VILLAGE && type !== "militia") {
    return { success: false };
  }

  if (getUnitAtTile(state.units, x, y)) {
    return { success: false };
  }

  const cost = UNIT_TYPES[type].cost;
  const player = state.currentPlayer;

  if (getPlayerGold(player) < cost) {
    return { success: false };
  }

  if (getSupplyUsed(player) >= getSupplyCapacity(player)) {
    return { success: false };
  }

  state.players[player].gold -= cost;

  const newId = state.units.length > 0
    ? Math.max(...state.units.map(unit => unit.id)) + 1
    : 1;

  const newUnit = createUnit(newId, type, player, x, y, false);

  state.units.push(newUnit);

  return { success: true };
}

export function applyEndTurn() {
  endTurn();
}

// Жив ли игрок: есть юниты или территория
function isPlayerAlive(playerId) {
  if (state.units.some(unit => unit.owner === playerId)) {
    return true;
  }

  const size = state.map.length;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (getTileOwner(x, y) === playerId) {
        return true;
      }
    }
  }

  return false;
}

// Следующий ход: по реестру мест, устранённые пропускаются.
// Это же правило считает сервер — поэтому очерёдность не разъезжается.
function getNextPlayer() {
  const ids = Object.keys(state.players)
    .map(Number)
    .filter(id => !state.eliminated.has(id))
    .sort((a, b) => a - b);

  if (ids.length === 0) {
    return state.currentPlayer;
  }

  const index = ids.indexOf(state.currentPlayer);
  const start = index === -1 ? 0 : index + 1;

  for (let step = 0; step < ids.length; step++) {
    const candidate = ids[(start + step) % ids.length];

    if (candidate !== state.currentPlayer && isPlayerAlive(candidate)) {
      return candidate;
    }
  }

  // Все остальные «мертвы» по юнитам, но места живы:
  // ход всё равно передаём по реестру
  for (let step = 0; step < ids.length; step++) {
    const candidate = ids[(start + step) % ids.length];

    if (candidate !== state.currentPlayer) {
      return candidate;
    }
  }

  return state.currentPlayer;
}

export function endTurn() {
  for (const unit of state.units) {
    if (unit.owner === state.currentPlayer) {
      captureTile(unit);
    }
  }

  state.currentPlayer = getNextPlayer();

  for (const unit of state.units) {
    if (unit.owner === state.currentPlayer) {
      unit.hasAttacked = false;
      unit.movementLeft = UNIT_TYPES[unit.type].movement;
    }
  }

  collectIncome(state.currentPlayer);

  state.selectedUnit = null;
  state.selectedTile = null;
  state.reachableTiles = new Map();
  state.attackableTiles = new Map();

  checkEliminationAndVictory();
}

// Устранение места (бой, дисконнект, решение хоста при возврате):
// юниты исчезают, здания нейтрализуются, место выходит из очерёдности
export function eliminatePlayer(playerId, nextTurn = null) {
  state.eliminated.add(playerId);
  state.units = state.units.filter(unit => unit.owner !== playerId);

  const size = state.map.length;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (getTileOwner(x, y) === playerId) {
        state.owners.set(`${x},${y}`, 0);
      }
    }
  }

  if (state.currentPlayer === playerId) {
    const ids = Object.keys(state.players)
      .map(Number)
      .filter(id => !state.eliminated.has(id))
      .sort((a, b) => a - b);

    const target =
      nextTurn !== null && nextTurn !== undefined && ids.includes(nextTurn)
        ? nextTurn
        : getNextPlayer();

    state.currentPlayer = target;

    for (const unit of state.units) {
      if (unit.owner === target) {
        unit.hasAttacked = false;
        unit.movementLeft = UNIT_TYPES[unit.type].movement;
      }
    }

    collectIncome(target);
  }

  if (state.selectedUnit && !state.units.includes(state.selectedUnit)) {
    state.selectedUnit = null;
    state.selectedTile = null;
    state.reachableTiles = new Map();
    state.attackableTiles = new Map();
  }

  checkEliminationAndVictory();
}

export function checkEliminationAndVictory() {
  if (state.gameOver) {
    return;
  }

  const playersWithUnits = new Set();

  for (const unit of state.units) {
    playersWithUnits.add(unit.owner);
  }

  const playersWithTerritories = new Set();
  const size = state.map.length;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const owner = getTileOwner(x, y);

      if (owner !== 0) {
        playersWithTerritories.add(owner);
      }
    }
  }

  const allPlayers = Object.keys(state.players)
    .map(Number)
    .filter(id => !state.eliminated.has(id));

  const alivePlayers = allPlayers.filter(
    player => playersWithUnits.has(player) || playersWithTerritories.has(player)
  );

  if (alivePlayers.length === 0) {
    state.gameOver = true;
    state.winner = null;
  } else if (alivePlayers.length === 1) {
    state.gameOver = true;
    state.winner = alivePlayers[0];
  }
}

export function getTileFromClick(event) {
  const canvas = state.canvas;
  const rect = canvas.getBoundingClientRect();

  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  const canvasX = (event.clientX - rect.left) * scaleX;
  const canvasY = (event.clientY - rect.top) * scaleY;

  const size = state.map.length;

  const x = Math.floor(canvasX / state.tileSize);
  const y = Math.floor(canvasY / state.tileSize);

  if (x < 0 || x >= size || y < 0 || y >= size) {
    return null;
  }

  return { x, y };
}