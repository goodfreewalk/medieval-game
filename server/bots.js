// Планировщик ходов бота. Работает на серверном зеркале состояния
// (синглтон state из public/js/state.js, загруженный комнатой).
import { UNIT_TYPES, getDistance, getUnitAtTile } from "../public/js/units.js";
import {
  getReachableTiles,
  canAttackUnit,
  calculateDamage
} from "../public/js/logic.js";
import {
  getTileOwner,
  getPlayerGold,
  getSupplyUsed,
  getSupplyCapacity
} from "../public/js/state.js";
import { TERRAIN } from "../public/js/terrain.js";

// Одно действие за вызов: атака → найм → движение. null = конец хода
export function planBotAction(state, personality) {
  const attack = planAttack(state, personality);
  if (attack) {
    return attack;
  }

  const recruit = planRecruit(state, personality);
  if (recruit) {
    return recruit;
  }

  return planMove(state, personality);
}

// ---------- Атака ----------

function planAttack(state, personality) {
  const me = state.currentPlayer;
  let best = null;
  let bestScore = -1;

  for (const unit of state.units) {
    if (unit.owner !== me || unit.hasAttacked) {
      continue;
    }

    for (const enemy of state.units) {
      if (enemy.owner === me) {
        continue;
      }

      if (!canAttackUnit(unit, enemy)) {
        continue;
      }

      const damage = calculateDamage(unit, enemy);
      const kill = damage >= enemy.hp;

      // Риск контратаки: умрём ли мы в ответ
      let counterKill = false;
      if (!kill) {
        const counter = calculateDamage(enemy, unit);
        counterKill = counter >= unit.hp;
      }

      const enemyValue = UNIT_TYPES[enemy.type].cost;

      let score = damage + enemyValue * 0.5;
      if (kill) {
        score += 500 + enemyValue;
      }

      if (personality === "balanced") {
        // Осторожный: не подставляемся под размен без выгоды
        if (counterKill && !kill) {
          continue;
        }
        if (damage < 25 && !kill) {
          continue;
        }
      } else if (counterKill && !kill && damage < 40) {
        // Агрессивный тоже не любит умирать впустую
        continue;
      }

      if (score > bestScore) {
        bestScore = score;
        best = {
          kind: "attack",
          attackerId: unit.id,
          targetId: enemy.id
        };
      }
    }
  }

  return best;
}

// ---------- Найм ----------

function planRecruit(state, personality) {
  const me = state.currentPlayer;
  const gold = getPlayerGold(me);
  const supplyFree = getSupplyCapacity(me) - getSupplyUsed(me);

  if (supplyFree <= 0) {
    return null;
  }

  const reserve = personality === "balanced" ? 20 : 0;
  const size = state.map.length;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (getTileOwner(x, y) !== me) {
        continue;
      }

      const terrain = state.map[y][x];

      if (terrain !== TERRAIN.CASTLE && terrain !== TERRAIN.VILLAGE) {
        continue;
      }

      if (getUnitAtTile(state.units, x, y)) {
        continue;
      }

      const options = terrain === TERRAIN.VILLAGE
        ? ["militia"]
        : ["heavyCavalry", "swordsman", "archer", "lightCavalry", "militia"];

      for (const type of options) {
        const cost = UNIT_TYPES[type].cost;

        if (gold - cost < reserve) {
          continue;
        }

        // Сбалансированный не штапует дорогих подряд: чередует лучника/мечника
        if (personality === "balanced" && terrain === TERRAIN.CASTLE) {
          const archers = state.units.filter(
            u => u.owner === me && u.type === "archer"
          ).length;
          const swordsmen = state.units.filter(
            u => u.owner === me && u.type === "swordsman"
          ).length;

          if (type === "heavyCavalry" && gold < 95) {
            continue;
          }
          if (type === "swordsman" && archers <= swordsmen && gold >= 30) {
            continue;
          }
          if (type === "archer" && archers > swordsmen + 1) {
            continue;
          }
        }

        return { kind: "recruit", type, x, y };
      }
    }
  }

  return null;
}

// ---------- Движение ----------

function collectTargets(state, me, personality) {
  const targets = [];
  const size = state.map.length;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const owner = getTileOwner(x, y);
      const terrain = state.map[y][x];

      if (terrain !== TERRAIN.CASTLE && terrain !== TERRAIN.VILLAGE) {
        continue;
      }

      if (owner === 0) {
        // Нейтральные здания: сбалансированный ценит их выше всего
        targets.push({
          x,
          y,
          weight: personality === "balanced" ? 3 : 1.5
        });
      } else if (owner !== me) {
        targets.push({
          x,
          y,
          weight: personality === "balanced" ? 1.5 : 2
        });
      }
    }
  }

  for (const unit of state.units) {
    if (unit.owner !== me) {
      targets.push({
        x: unit.x,
        y: unit.y,
        weight: personality === "aggressive" ? 2.5 : 1
      });
    }
  }

  return targets;
}

function planMove(state, personality) {
  const me = state.currentPlayer;
  const targets = collectTargets(state, me, personality);

  if (targets.length === 0) {
    return null;
  }

  let best = null;
  let bestGain = 0;

  for (const unit of state.units) {
    if (unit.owner !== me) {
      continue;
    }

    // Двигаем только ещё не ходивших в этот ход
    if (unit.hasAttacked || unit.movementLeft <= 0) {
      continue;
    }
    if (unit.movementLeft < UNIT_TYPES[unit.type].movement) {
      continue;
    }

    const currentDist = Math.min(
      ...targets.map(t => getDistance(unit, t) * 1 / t.weight)
    );

    const reachable = getReachableTiles(unit);

    for (const tile of reachable.values()) {
      const dist = Math.min(
        ...targets.map(
          t => (Math.abs(tile.x - t.x) + Math.abs(tile.y - t.y)) / t.weight
        )
      );

      const gain = currentDist - dist;

      if (gain > bestGain) {
        bestGain = gain;
        best = { kind: "move", unitId: unit.id, x: tile.x, y: tile.y };
      }
    }
  }

  return best;
}