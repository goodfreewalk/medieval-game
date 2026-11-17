// Планировщик ходов бота на серверном зеркале состояния.
// Долгосрочные цели и прошлые позиции хранятся в ctx.memory между ходами.
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
  getSupplyCapacity,
  areAllies
} from "../public/js/state.js";
import { TERRAIN, TERRAIN_COST, TERRAIN_DEFENSE } from "../public/js/terrain.js";

const THREAT_RADIUS = 4;
const BACKTRACK_PENALTY = 24;
const MISTAKE_RATE = 0.08;

function tileKey(x, y) {
  return `${x},${y}`;
}

function isBuilding(terrain) {
  return terrain === TERRAIN.CASTLE || terrain === TERRAIN.VILLAGE;
}

function eachBuilding(state, callback) {
  const size = state.map.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isBuilding(state.map[y][x])) callback(x, y, state.map[y][x]);
    }
  }
}

function isPardoned(personality, relations, owner) {
  return personality === "balanced" && (relations?.[owner] ?? 0) >= 40;
}

export function planBotAction(state, personality, ctx) {
  if (!ctx.memory) ctx.memory = { assignments: {}, previous: {} };
  if (!ctx.memory.assignments) ctx.memory.assignments = {};
  if (!ctx.memory.previous) ctx.memory.previous = {};
  ctx.currentUnits = Object.fromEntries(state.units.map(unit => [unit.id, unit]));
  ctx.distanceMaps = new Map();

  const defense = computeDefense(state, ctx.me);
  ctx.defense = defense.active;

  return planAttack(state, personality, ctx) ||
    planImmediateCapture(state, personality, ctx) ||
    planMove(state, personality, ctx, defense) ||
    planAid(state, personality, ctx) ||
    planRecruit(state, personality, ctx);
}

// ---------- Оценка угроз ----------

function forceNear(state, me, x, y, radius, enemies) {
  let force = 0;
  for (const unit of state.units) {
    if (enemies ? areAllies(unit.owner, me) : unit.owner !== me) continue;
    const distance = Math.abs(unit.x - x) + Math.abs(unit.y - y);
    if (distance > radius) continue;
    const stats = UNIT_TYPES[unit.type];
    force += (stats.attack * unit.hp / 100) * (radius + 1 - distance);
  }
  return force;
}

function computeDefense(state, me) {
  const targets = [];
  eachBuilding(state, (x, y, terrain) => {
    if (getTileOwner(x, y) !== me) return;
    const enemyForce = forceNear(state, me, x, y, THREAT_RADIUS, true);
    if (enemyForce <= 0) return;
    const garrison = forceNear(state, me, x, y, THREAT_RADIUS, false);
    const severity = enemyForce - garrison * 0.65 + (terrain === TERRAIN.CASTLE ? 15 : 0);
    if (severity > 18) targets.push({ x, y, severity });
  });

  targets.sort((a, b) => b.severity - a.severity);
  return { active: targets.length > 0, targets };
}

function threatToPlayer(state, playerId) {
  let threat = 0;
  eachBuilding(state, (x, y) => {
    if (getTileOwner(x, y) === playerId) {
      threat += forceNear(state, playerId, x, y, THREAT_RADIUS, true);
    }
  });
  return threat;
}

// ---------- Атака ----------

function planAttack(state, personality, ctx) {
  const candidates = [];

  for (const unit of state.units) {
    if (unit.owner !== ctx.me || unit.hasAttacked) continue;

    for (const enemy of state.units) {
      if (!canAttackUnit(unit, enemy)) continue;
      const relation = ctx.relations?.[enemy.owner] ?? 0;
      if (isPardoned(personality, ctx.relations, enemy.owner)) continue;

      const damage = calculateDamage(unit, enemy);
      const killed = damage >= enemy.hp;
      const canCounter = !killed && getDistance(unit, enemy) <= UNIT_TYPES[enemy.type].range;
      const counterDamage = canCounter ? calculateDamage(enemy, unit) : 0;
      const counterKill = counterDamage >= unit.hp;
      const revenge = relation <= -45;
      const friendlyGround = areAllies(getTileOwner(enemy.x, enemy.y), ctx.me);

      if (counterKill && personality === "balanced") continue;
      if (counterKill && personality === "aggressive" && !revenge && damage < 45) continue;
      if (personality === "balanced" && damage < 20 && !killed && !friendlyGround) continue;

      const enemyValue = UNIT_TYPES[enemy.type].cost;
      let score = damage * 2 + enemyValue * 1.2;
      if (killed) score += 1000 + enemyValue * 2;
      if (!canCounter) score += 35;
      if (friendlyGround) score += 140;
      if (revenge) score += personality === "aggressive" ? 180 : 70;
      score -= counterDamage * (personality === "aggressive" ? 0.8 : 2.2);
      if (counterKill) score -= 500;

      candidates.push({
        action: { kind: "attack", attackerId: unit.id, targetId: enemy.id },
        score,
        safe: !counterKill
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length === 0) return null;

  // Ошибка возможна только между безопасными атаками, добивание не упускается.
  if (
    candidates.length > 1 && candidates[0].safe && candidates[1].safe &&
    candidates[0].score < 900 && Math.random() < MISTAKE_RATE / 2
  ) {
    return candidates[1].action;
  }
  return candidates[0].action;
}

// ---------- Гарантированный захват ----------

function planImmediateCapture(state, personality, ctx) {
  let best = null;

  for (const unit of state.units) {
    if (unit.owner !== ctx.me || unit.hasAttacked || unit.movementLeft <= 0) continue;
    const reachable = getReachableTiles(unit);

    for (const tile of reachable.values()) {
      const terrain = state.map[tile.y][tile.x];
      if (!isBuilding(terrain)) continue;
      const owner = getTileOwner(tile.x, tile.y);
      if (areAllies(owner, ctx.me)) continue;

      let score = terrain === TERRAIN.CASTLE ? 1200 : 850;
      if (owner !== 0) score += personality === "aggressive" ? 140 : 60;
      score -= tile.cost;

      if (!best || score > best.score) {
        best = {
          score,
          action: { kind: "move", unitId: unit.id, x: tile.x, y: tile.y },
          targetKey: `building:${tile.x},${tile.y}`
        };
      }
    }
  }

  if (!best) return null;
  rememberMove(ctx, best.action, best.targetKey);
  return best.action;
}

// ---------- Помощь союзникам ----------

function planAid(state, personality, ctx) {
  if (ctx.memory.aidGiven) return null;
  const gold = getPlayerGold(ctx.me);
  let best = null;

  for (const key of Object.keys(state.players)) {
    const allyId = Number(key);
    if (allyId === ctx.me || !areAllies(allyId, ctx.me)) continue;
    if (state.eliminated?.has(allyId)) continue;

    const allyGold = getPlayerGold(allyId);
    const threat = threatToPlayer(state, allyId);
    const critical = allyGold < 15 || (allyGold < 30 && threat > 25);
    const surplus = gold >= (personality === "aggressive" ? 80 : 50);
    if (!critical && !surplus) continue;
    if (!critical && allyGold >= 40 && threat < 20) continue;

    const reserve = critical
      ? (personality === "aggressive" ? 10 : 15)
      : (personality === "aggressive" ? 30 : 20);
    const amount = gold - reserve >= 20 &&
      (critical || gold >= (personality === "aggressive" ? 100 : 70)) ? 20 : 10;
    if (gold - amount < reserve) continue;

    let building = null;
    eachBuilding(state, (x, y) => {
      if (!building && getTileOwner(x, y) === allyId) building = { x, y };
    });
    if (!building) continue;

    const score = threat + Math.max(0, 50 - allyGold) + (critical ? 100 : 0);
    if (!best || score > best.score) {
      best = {
        score,
        action: {
          kind: "sendGold",
          targetPlayer: allyId,
          x: building.x,
          y: building.y,
          amount
        }
      };
    }
  }

  if (!best) return null;
  ctx.memory.aidGiven = true;
  return best.action;
}

// ---------- Найм ----------

function planRecruit(state, personality, ctx) {
  const gold = getPlayerGold(ctx.me);
  if (getSupplyUsed(ctx.me) >= getSupplyCapacity(ctx.me)) return null;

  const reserve = personality === "balanced" && !ctx.defense ? 10 : 0;
  let order = ctx.defense
    ? ["swordsman", "archer", "militia", "lightCavalry", "horseArcher", "heavyCavalry"]
    : personality === "aggressive"
      ? ["heavyCavalry", "swordsman", "lightCavalry", "horseArcher", "archer", "militia"]
      : ["archer", "swordsman", "lightCavalry", "horseArcher", "militia", "heavyCavalry"];

  if (!ctx.defense && Math.random() < MISTAKE_RATE / 2 && order.length > 1) {
    [order[0], order[1]] = [order[1], order[0]];
  }

  let best = null;
  eachBuilding(state, (x, y, terrain) => {
    if (getTileOwner(x, y) !== ctx.me || getUnitAtTile(state.units, x, y)) return;
    const options = terrain === TERRAIN.VILLAGE ? ["militia"] : order;
    const type = options.find(unitType => gold - UNIT_TYPES[unitType].cost >= reserve);
    if (!type) return;

    const threat = forceNear(state, ctx.me, x, y, THREAT_RADIUS, true);
    const score = threat + (terrain === TERRAIN.CASTLE ? 10 : 0);
    if (!best || score > best.score) {
      best = { score, action: { kind: "recruit", type, x, y } };
    }
  });

  return best?.action || null;
}

// ---------- Цели и пути ----------

function collectTargets(state, personality, ctx, defense) {
  const targets = [];

  for (const building of defense.targets) {
    targets.push({
      key: `defense:${building.x},${building.y}`,
      kind: "defense",
      x: building.x,
      y: building.y,
      weight: 7 + building.severity / 30
    });
  }

  eachBuilding(state, (x, y, terrain) => {
    const owner = getTileOwner(x, y);
    if (!areAllies(owner, ctx.me)) {
      const relation = ctx.relations?.[owner] ?? 0;
      if (owner !== 0 && isPardoned(personality, ctx.relations, owner)) return;
      let weight = terrain === TERRAIN.CASTLE ? 4.5 : 3.8;
      if (owner !== 0) weight += personality === "aggressive" ? 1.8 : 0.4;
      if (relation <= -40) weight += personality === "aggressive" ? 1.8 : 0.7;
      targets.push({ key: `building:${x},${y}`, kind: "building", x, y, weight });
      return;
    }

    if (owner !== ctx.me && owner !== 0) {
      const threat = forceNear(state, owner, x, y, THREAT_RADIUS, true);
      if (threat > 20) {
        targets.push({
          key: `support:${x},${y}`,
          kind: "support",
          x,
          y,
          weight: (personality === "aggressive" ? 2.5 : 4.5) + threat / 60
        });
      }
    }
  });

  for (const enemy of state.units) {
    if (areAllies(enemy.owner, ctx.me)) continue;
    if (isPardoned(personality, ctx.relations, enemy.owner)) continue;
    const relation = ctx.relations?.[enemy.owner] ?? 0;
    let weight = personality === "aggressive" ? 3.2 : 1.8;
    if (relation <= -40) weight += 1.2;
    if (areAllies(getTileOwner(enemy.x, enemy.y), ctx.me)) weight += 3;
    targets.push({
      key: `unit:${enemy.id}`,
      kind: "unit",
      unitId: enemy.id,
      x: enemy.x,
      y: enemy.y,
      weight
    });
  }

  return targets;
}

function distanceMap(state, target, me, ctx) {
  const cacheKey = tileKey(target.x, target.y);
  if (ctx.distanceMaps.has(cacheKey)) return ctx.distanceMaps.get(cacheKey);

  const size = state.map.length;
  const costs = new Map([[cacheKey, 0]]);
  const queue = [{ x: target.x, y: target.y, cost: 0 }];
  const directions = [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }];

  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost);
    const current = queue.shift();
    if (current.cost !== costs.get(tileKey(current.x, current.y))) continue;

    for (const direction of directions) {
      const x = current.x + direction.x;
      const y = current.y + direction.y;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const terrainCost = TERRAIN_COST[state.map[y][x]];
      if (terrainCost === Infinity) continue;
      const occupant = getUnitAtTile(state.units, x, y);
      if (occupant && !areAllies(occupant.owner, me)) continue;

      const cost = current.cost + terrainCost;
      const key = tileKey(x, y);
      if (costs.has(key) && costs.get(key) <= cost) continue;
      costs.set(key, cost);
      queue.push({ x, y, cost });
    }
  }

  ctx.distanceMaps.set(cacheKey, costs);
  return costs;
}

function pathCost(costs, x, y) {
  return costs.get(tileKey(x, y)) ?? 10000;
}

function chooseTarget(state, unit, targets, personality, ctx) {
  const previousKey = ctx.memory.assignments[unit.id];
  const previous = targets.find(target => target.key === previousKey);
  if (previous) {
    const costs = distanceMap(state, previous, ctx.me, ctx);
    if (pathCost(costs, unit.x, unit.y) < 10000) return previous;
  }

  let best = null;
  for (const target of targets) {
    const costs = distanceMap(state, target, ctx.me, ctx);
    const distance = pathCost(costs, unit.x, unit.y);
    if (distance >= 10000) continue;
    const used = ctx.usage?.get(target.key) || 0;
    const assigned = Object.values(ctx.memory.assignments)
      .filter(key => key === target.key).length;
    let score = target.weight * 30 - distance * 4 - used * 20 - assigned * 12;
    if (personality === "aggressive" && target.kind === "unit") score += 15;
    if (!best || score > best.score) best = { target, score };
  }

  return best?.target || null;
}

function evaluateMove(state, unit, tile, target, costs, personality, ctx) {
  const currentDistance = pathCost(costs, unit.x, unit.y);
  const nextDistance = pathCost(costs, tile.x, tile.y);
  let score = (currentDistance - nextDistance) * 14 - tile.cost * 0.4;
  const terrain = state.map[tile.y][tile.x];
  const owner = getTileOwner(tile.x, tile.y);
  const captures = isBuilding(terrain) && !areAllies(owner, ctx.me);

  if (captures) score += terrain === TERRAIN.CASTLE ? 300 : 200;
  if (target.kind === "defense" || target.kind === "support") {
    if (tile.x === target.x && tile.y === target.y) score += 60;
  }

  const movedUnit = { ...unit, x: tile.x, y: tile.y };
  let attackBonus = 0;
  let danger = 0;
  for (const enemy of state.units) {
    if (areAllies(enemy.owner, ctx.me)) continue;
    const distance = getDistance(movedUnit, enemy);
    if (canAttackUnit(movedUnit, enemy) && !isPardoned(personality, ctx.relations, enemy.owner)) {
      const damage = calculateDamage(movedUnit, enemy);
      let value = damage * (personality === "aggressive" ? 1.2 : 0.7);
      if (damage >= enemy.hp) value += 150 + UNIT_TYPES[enemy.type].cost;
      attackBonus = Math.max(attackBonus, value);
    }
    if (distance <= UNIT_TYPES[enemy.type].range) {
      danger += calculateDamage(enemy, movedUnit);
    }
  }

  score += attackBonus;
  score -= danger * (personality === "aggressive" ? 0.25 : 0.8);
  score += (TERRAIN_DEFENSE[terrain] || 0) * (personality === "aggressive" ? 0.2 : 0.55);

  const previous = ctx.memory.previous[unit.id];
  const backtracks = previous && previous.x === tile.x && previous.y === tile.y;
  if (backtracks && !captures) score -= BACKTRACK_PENALTY;

  return { score, captures, backtracks };
}

function planMove(state, personality, ctx, defense) {
  const me = ctx.me;
  const liveIds = new Set(state.units.filter(unit => unit.owner === me).map(unit => unit.id));
  for (const id of Object.keys(ctx.memory.assignments)) {
    if (!liveIds.has(Number(id))) delete ctx.memory.assignments[id];
  }

  const targets = collectTargets(state, personality, ctx, defense);
  if (targets.length === 0) return null;
  const candidates = [];

  for (const unit of state.units) {
    if (unit.owner !== me || unit.hasAttacked || unit.movementLeft <= 0) continue;
    const standingTerrain = state.map[unit.y][unit.x];
    if (isBuilding(standingTerrain) && !areAllies(getTileOwner(unit.x, unit.y), me)) {
      continue;
    }

    const target = chooseTarget(state, unit, targets, personality, ctx);
    if (!target) continue;
    ctx.memory.assignments[unit.id] = target.key;
    if (target.kind === "unit") {
      const enemy = state.units.find(other => other.id === target.unitId);
      if (!enemy) continue;
      target.x = enemy.x;
      target.y = enemy.y;
    }

    const costs = distanceMap(state, target, me, ctx);
    const reachable = getReachableTiles(unit);
    for (const tile of reachable.values()) {
      const evaluation = evaluateMove(state, unit, tile, target, costs, personality, ctx);
      if (evaluation.score <= 0.5) continue;
      candidates.push({
        action: { kind: "move", unitId: unit.id, x: tile.x, y: tile.y },
        targetKey: target.key,
        ...evaluation
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length === 0) return null;

  let selected = candidates[0];
  const alternatives = candidates.filter(candidate =>
    !candidate.captures && !candidate.backtracks &&
    candidate.score >= selected.score - 10
  );
  if (alternatives.length > 1 && !selected.captures && Math.random() < MISTAKE_RATE) {
    selected = alternatives[1];
  }

  rememberMove(ctx, selected.action, selected.targetKey);
  return selected.action;
}

function rememberMove(ctx, action, targetKey) {
  const current = ctx.currentUnits?.[action.unitId];
  if (current) ctx.memory.previous[action.unitId] = { x: current.x, y: current.y };
  ctx.memory.assignments[action.unitId] = targetKey;
  if (ctx.usage) ctx.usage.set(targetKey, (ctx.usage.get(targetKey) || 0) + 1);
}
