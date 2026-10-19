// Планировщик ходов бота на серверном зеркале состояния.
// ctx = { me, relations: {targetId: score}, usage: Map("x,y"->count), defense: bool }
// relations[me][target] — как БОТ относится к цели (для веса атаки/пощады).
// usage — счётчик выбранных целей в рамках текущего хода (разводит армию).
// defense — режим «дом под угрозой» (переключает движение/найм на оборону).
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

const THREAT_RADIUS = 4;     // радиус оценки угрозы дому (клеток)
const THREAT_LEVEL = 30;     // порог силы врага у дома для режима обороны
const PARDON_PROX = 3;       // «мог ударить, но не ударил» — радиус пощады
const USAGE_PENALTY = 0.9;   // штраф за уже занятую цель (лечит толпу)
const NOISE = 6;             // темпераментный шум в оценке цели

function rand(seed) {
  // дешёвый шум без состояния
  return (Math.random() * 2 - 1) * seed;
}

export function planBotAction(state, personality, ctx) {
  const me = ctx.me;
  const defense = computeDefense(state, me);
  ctx.defense = defense.active;

  const attack = planAttack(state, personality, ctx);
  if (attack) return attack;

  const recruit = planRecruit(state, personality, ctx);
  if (recruit) return recruit;

  return planMove(state, personality, ctx, defense);
}

// ---------- Оборона дома ----------

function ownCastle(state, me) {
  const size = state.map.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (
        state.map[y][x] === TERRAIN.CASTLE &&
        getTileOwner(x, y) === me
      ) {
        return { x, y };
      }
    }
  }
  return null;
}

// Возвращает { active, targets:[{x,y}] } — свои здания под угрозой
function computeDefense(state, me) {
  const castle = ownCastle(state, me);
  if (!castle) return { active: false, targets: [] };

  let enemyForce = 0;
  const threatened = [];

  for (const u of state.units) {
    if (u.owner === me) continue;
    const d = Math.abs(u.x - castle.x) + Math.abs(u.y - castle.y);
    if (d <= THREAT_RADIUS) {
      enemyForce += UNIT_TYPES[u.type].attack + (u.hp / 20);
    }
  }

  // свои юниты-гарнизон рядом с замком
  let garrison = 0;
  for (const u of state.units) {
    if (u.owner !== me) continue;
    const d = Math.abs(u.x - castle.x) + Math.abs(u.y - castle.y);
    if (d <= THREAT_RADIUS) garrison += UNIT_TYPES[u.type].attack;
  }

  const active = enemyForce - garrison > THREAT_LEVEL;
  if (active) threatened.push(castle);

  return { active, targets: threatened };
}

// ---------- Атака ----------

function relationWeight(personality, rel) {
  // rel = relations[me][target]: <0 вражда, >0 доверие
  const k = personality === "aggressive" ? 0.014 : 0.008;
  let m = 1 + k * -rel;
  return Math.max(0.5, Math.min(2.0, m));
}

function planAttack(state, personality, ctx) {
  const me = ctx.me;
  let best = null;
  let bestScore = -Infinity;

  for (const unit of state.units) {
    if (unit.owner !== me || unit.hasAttacked) continue;

    for (const enemy of state.units) {
      if (enemy.owner === me) continue;
      if (!canAttackUnit(unit, enemy)) continue;

      const rel = ctx.relations?.[enemy.owner] ?? 0;

      // Сбалансированный не бьёт тех, кому доверяет (мир без протокола)
      if (personality === "balanced" && rel >= 40) continue;

      const damage = calculateDamage(unit, enemy);
      const kill = damage >= enemy.hp;

      let counterKill = false;
      if (!kill) {
        counterKill = calculateDamage(enemy, unit) >= unit.hp;
      }

      const enemyValue = UNIT_TYPES[enemy.type].cost;
      let score = damage + enemyValue * 0.5 + rand(NOISE);
      if (kill) score += 500 + enemyValue;

      score *= relationWeight(personality, rel);

      // Месть: агрессивный идёт в размен даже под угрозу гибели ради врага
      const revenge = personality === "aggressive" && rel <= -50;

      if (counterKill && !kill) {
        if (personality === "balanced") continue;
        if (!revenge && damage < 40) continue;
      }
      if (personality === "balanced" && damage < 25 && !kill) continue;

      if (score > bestScore) {
        bestScore = score;
        best = { kind: "attack", attackerId: unit.id, targetId: enemy.id };
      }
    }
  }

  return best;
}

// ---------- Найм ----------

function planRecruit(state, personality, ctx) {
  const me = ctx.me;
  const gold = getPlayerGold(me);
  const supplyFree = getSupplyCapacity(me) - getSupplyUsed(me);
  if (supplyFree <= 0) return null;

  const reserve = personality === "balanced" && !ctx.defense ? 20 : 0;
  const size = state.map.length;

  // В обороне приоритет — защитники у замка; иначе — ударная масса
  const order = ctx.defense
    ? ["swordsman", "archer", "militia", "lightCavalry"]
    : personality === "aggressive"
      ? ["heavyCavalry", "swordsman", "lightCavalry", "archer", "militia"]
      : ["archer", "swordsman", "lightCavalry", "militia", "heavyCavalry"];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (getTileOwner(x, y) !== me) continue;
      const terrain = state.map[y][x];
      if (terrain !== TERRAIN.CASTLE && terrain !== TERRAIN.VILLAGE) continue;
      if (getUnitAtTile(state.units, x, y)) continue;

      const options = terrain === TERRAIN.VILLAGE
        ? ["militia"]
        : order.filter(t => UNIT_TYPES[t]);

      for (const type of options) {
        const cost = UNIT_TYPES[type].cost;
        if (gold - cost < reserve) continue;
        return { kind: "recruit", type, x, y };
      }
    }
  }
  return null;
}

// ---------- Движение с ролями (разведение армии) ----------

function collectTargets(state, me, personality, defense) {
  const targets = [];
  const size = state.map.length;

  // В обороне главные цели — угрожаемые свои здания (тянемся домой)
  if (defense.active) {
    for (const t of defense.targets) {
      targets.push({ x: t.x, y: t.y, weight: 6 });
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const owner = getTileOwner(x, y);
      const terrain = state.map[y][x];
      if (terrain !== TERRAIN.CASTLE && terrain !== TERRAIN.VILLAGE) continue;

      if (owner === 0) {
        targets.push({
          x, y,
          weight: personality === "balanced" ? 3 : 1.5
        });
      } else if (owner !== me) {
        // вражеские здания: вес зависит от отношения к владельцу
        const rel = defense.active ? 0 : (state._rel?.[owner] ?? 0);
        targets.push({
          x, y,
          weight: (personality === "balanced" ? 1.5 : 2) *
            (rel <= -40 ? 1.6 : 1)
        });
      }
    }
  }

  if (!defense.active) {
    for (const unit of state.units) {
      if (unit.owner === me) continue;
      const rel = state._rel?.[unit.owner] ?? 0;
      targets.push({
        x: unit.x, y: unit.y,
        weight: (personality === "aggressive" ? 2.5 : 1) *
          (rel <= -40 ? 1.5 : 1)
      });
    }
  }

  return targets;
}

function planMove(state, personality, ctx, defense) {
  const me = ctx.me;
  state._rel = ctx.relations; // прокидываем в collectTargets
  const targets = collectTargets(state, me, personality, defense);
  state._rel = null;
  if (targets.length === 0) return null;

  let best = null;
  let bestGain = 0;

  for (const unit of state.units) {
    if (unit.owner !== me) continue;
    if (unit.hasAttacked || unit.movementLeft <= 0) continue;
    if (unit.movementLeft < UNIT_TYPES[unit.type].movement) continue;

    const reach = getReachableTiles(unit);
    if (reach.size === 0) continue;

    for (const tile of reach.values()) {
      // лучшая цель для этой клетки с учётом занятости других юнитов
      let targetScore = -Infinity;
      let targetKey = null;

      for (const t of targets) {
        const dist = Math.abs(tile.x - t.x) + Math.abs(tile.y - t.y);
        const usage = ctx.usage?.get(`${t.x},${t.y}`) || 0;
        const s = t.weight / (dist + 1) - USAGE_PENALTY * usage;
        if (s > targetScore) {
          targetScore = s;
          targetKey = `${t.x},${t.y}`;
        }
      }

      const curDist = Math.min(
        ...targets.map(t =>
          (Math.abs(unit.x - t.x) + Math.abs(unit.y - t.y)) / t.weight
        )
      );
      const newDist = Math.min(
        ...targets.map(t =>
          (Math.abs(tile.x - t.x) + Math.abs(tile.y - t.y)) / t.weight
        )
      );
      const gain = (curDist - newDist) + rand(NOISE * 0.3);

      if (gain > bestGain) {
        bestGain = gain;
        best = { kind: "move", unitId: unit.id, x: tile.x, y: tile.y };
        best._targetKey = targetKey;
      }
    }
  }

  if (best && ctx.usage) {
    const key = best._targetKey;
    if (key) ctx.usage.set(key, (ctx.usage.get(key) || 0) + 1);
    delete best._targetKey;
  }

  return best;
}