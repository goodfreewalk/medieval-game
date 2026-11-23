// scripts/check.mjs — синтаксис ESM + симметрия карт + детерминизм checksum.
// Запуск: npm run check (node --experimental-vm-modules scripts/check.mjs)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { MAPS, parseMap } from "../public/js/maps.js";
import { TERRAIN } from "../public/js/terrain.js";
import { state, initGame, resetState } from "../public/js/state.js";
import { applyEndTurn } from "../public/js/logic.js";
import { computeChecksum } from "../public/js/checksum.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const ok = m => console.log("ok  -", m);
const fail = m => { failures++; console.error("FAIL-", m); };

// 1. Синтаксис ESM: парсинг БЕЗ исполнения (DOM-модули клиента не падают в Node)
for (const dir of ["public/js", "server"]) {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) continue;
  for (const f of fs.readdirSync(full).filter(x => x.endsWith(".js"))) {
    try {
      new vm.SourceTextModule(fs.readFileSync(path.join(full, f), "utf8"), { identifier: dir + "/" + f });
      ok("syntax " + dir + "/" + f);
    } catch (e) { fail("syntax " + dir + "/" + f + ": " + e.message); }
  }
}

// 2. Карты: симметрия ландшафта + равенство зданий/стартов + нейтрали 2/2 или 4/4
const transforms = [
  ["rot180", (x, y, n) => [n - 1 - x, n - 1 - y]],
  ["mirrorX", (x, y, n) => [n - 1 - x, y]],
  ["mirrorY", (x, y, n) => [x, n - 1 - y]]
];
for (const map of MAPS) {
  const p = parseMap(map);
  const n = p.size;
  let sym = null;
  for (const [name, fn] of transforms) {
    let good = true;
    for (let y = 0; y < n && good; y++)
      for (let x = 0; x < n && good; x++) {
        const [tx, ty] = fn(x, y, n);
        if (p.terrain[y][x] !== p.terrain[ty][tx]) good = false;
      }
    if (good) { sym = name; break; }
  }
  if (!sym) { fail("map " + map.id + ": ландшафт не симметричен"); continue; }
  ok("map " + map.id + ": symmetry " + sym);

  const perOwner = {};
  for (const e of p.owners) {
    const t = p.terrain[e.y][e.x];
    const kind = t === TERRAIN.CASTLE ? "castle" : t === TERRAIN.VILLAGE ? "village" : null;
    if (!kind) continue;
    perOwner[e.owner] = perOwner[e.owner] || { castle: 0, village: 0 };
    perOwner[e.owner][kind]++;
  }
  // Нейтрали — символы C/V карты: parseMap не кладёт их в owners
  let neutralCastle = 0, neutralVillage = 0;
  for (const row of map.rows) {
    for (const ch of row) {
      if (ch === "C") neutralCastle++;
      else if (ch === "V") neutralVillage++;
    }
  }
  const counts = Object.values(perOwner).map(c => c.castle + ":" + c.village);
  if (new Set(counts).size > 1) fail("map " + map.id + ": разный набор зданий у игроков " + counts.join(","));
  else ok("map " + map.id + ": здания игроков равны");
  if (neutralCastle !== neutralVillage || ![2, 4].includes(neutralCastle))
    fail("map " + map.id + ": нейтрали " + neutralCastle + "/" + neutralVillage + " (ожидается 2/2 или 4/4)");
  else ok("map " + map.id + ": нейтрали " + neutralCastle + "/" + neutralVillage);

  const starts = {};
  for (const s of p.starts) starts[s.owner] = (starts[s.owner] || 0) + 1;
  if (new Set(Object.values(starts)).size > 1) fail("map " + map.id + ": разное число стартовых юнитов");
  else ok("map " + map.id + ": старты равны");
}

// 3. Детерминизм: две одинаковые последовательности ходов дают одинаковые суммы
function sequence() {
  resetState();
  initGame(null, null, { mapId: "classic", seats: [1, 2] });
  const sums = [computeChecksum(state)];
  for (let i = 0; i < 6; i++) { applyEndTurn(); sums.push(computeChecksum(state)); }
  return sums.join(",");
}
const a = sequence(), b = sequence();
if (a === b) ok("checksum determinism");
else fail("checksum nondeterministic: " + a + " vs " + b);

console.log(failures ? "\n" + failures + " FAIL(s)" : "\nALL PASS");
process.exit(failures ? 1 : 0);