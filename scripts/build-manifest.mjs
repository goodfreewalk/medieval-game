// Сборка спрайтов и манифеста из public/assets/raw/*.png.
// Запуск: node scripts/build-manifest.mjs
//
// Правила (notes/art-style.md):
//  - chroma-key = цвет из угла PNG, tolerance ±10 (мягкий край до ±20) + despill;
//    применяется ТОЛЬКО если угол magenta-подобный (спрайты на magenta-фоне).
//    Full-bleed тайлы (угол = цвет местности) НЕ кейятся — иначе дыры в текстуре.
//  - даунскейл до tile:64 area-average (premultiplied alpha);
//  - тайлы: лёгкий wrap-crossfade краёв (4 px) для бесшовности;
//  - результат: public/assets/sprites/<id>.png (64x64, RGBA) + manifest.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePNG, encodePNG } from "./lib/png.mjs";
import { UNIT_PROMPTS } from "./lib/assets.mjs";

const ROOT = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");
const RAW_DIR = path.join(ROOT, "public", "assets", "raw");
const OUT_DIR = path.join(ROOT, "public", "assets", "sprites");
const TILE = 64;
const TOL = 10;
const SOFT = 20;
const SEAM = 4;

const TERRAIN_IDS = ["grass", "forest", "hills", "water", "mountain"];
const PROP_IDS = ["castle", "village", "banner", "gold"];
const FRAMES = ["walkA", "walkB", "attack"];

// Брак бесплатного провайдера, не лечится кейингом (см. notes/graphics-quality.md):
// castle — «призрачный» рендер, стены растворены в фоне;
// village — белые дома на белом фоне, кейинг съедает стены.
// Перегенерировать с ключевым провайдером и убрать из списка.
const SKIP_IDS = new Set(["prop-castle", "prop-village"]);
// спрайт, у которого фон не отделился (провайдер дал розовый-на-розовом),
// в манифест не берём: лучше фолбэк-круг, чем розовый квадрат на карте
const MIN_TRANSPARENT = 0.25;

// Бесплатный провайдер рисует водяной знак в правом нижнем углу даже с
// nologo=true. Вырезаем детерминированно: тайлы — зеркальным блоком из
// левого верхнего угла, спрайты — цветом угла (уйдёт в chroma-key).
function deWatermark(img, isTile) {
  const { width, height, data } = img;
  const x0 = Math.floor(width * 0.70);
  const y0 = Math.floor(height * 0.92);
  for (let y = y0; y < height; y++) {
    for (let x = x0; x < width; x++) {
      const d = (y * width + x) * 4;
      const s = isTile
        ? ((height - 1 - y) * width + (width - 1 - x)) * 4
        : 0;
      data[d] = data[s];
      data[d + 1] = data[s + 1];
      data[d + 2] = data[s + 2];
      data[d + 3] = data[s + 3];
    }
  }
}

// Фон спрайта убирается contiguous flood-fill от каймы с локальным
// допуском ±10 на соседних пикселях («волшебная палочка»): следует по
// градиентному фону (провайдер даёт magenta/белый/серый вместо заказа),
// останавливается на резких контурах контента. Тайлы full-bleed не кейятся.
function chromaKey(img, isTile) {
  if (isTile) return;

  const { data, width, height } = img;
  const n = width * height;
  const alpha = new Uint8Array(n).fill(255);
  const seen = new Uint8Array(n);
  const queue = [];

  const diff = (i, j) => {
    const a = i * 4, b = j * 4;
    return Math.max(
      Math.abs(data[a] - data[b]),
      Math.abs(data[a + 1] - data[b + 1]),
      Math.abs(data[a + 2] - data[b + 2])
    );
  };

  // Фон-подобный: нейтральный (белый/серый градиент, max-min <= 30) или
  // magenta. Fill шагом ±10 + прыжки нейтраль→нейтраль (серая рамка →
  // белый интерьер); насыщенный контент (розовый/фиолетовый/золото)
  // не фон-подобный и не трогается. Проверено смоуком на :8090.
  const neutral = (i) => {
    const d = i * 4;
    return Math.max(data[d], data[d + 1], data[d + 2]) -
      Math.min(data[d], data[d + 1], data[d + 2]) <= 30;
  };
  // magenta-фон провайдера — СВЕТлый розовый градиент; тёмная magenta-броня
  // юнита того же оттенка, но min-канал низкий → контент не трогаем
  const magenta = (i) => {
    const d = i * 4;
    const r = data[d], g = data[d + 1], b = data[d + 2];
    return r > 150 && b > 150 && g < r - 30 && Math.min(r, g, b) >= 100;
  };
  const bgLike = (i) => neutral(i) || magenta(i);

  const seed = (x, y) => {
    const i = y * width + x;
    if (!bgLike(i)) return;
    seen[i] = 1;
    alpha[i] = 0;
    queue.push(i);
  };
  for (let x = 0; x < width; x++) { seed(x, 0); seed(x, height - 1); }
  for (let y = 0; y < height; y++) { seed(0, y); seed(width - 1, y); }

  while (queue.length) {
    const i = queue.pop();
    const x = i % width, y = (i / width) | 0;
    const nb = [];
    if (x + 1 < width) nb.push(i + 1);
    if (x > 0) nb.push(i - 1);
    if (y + 1 < height) nb.push(i + width);
    if (y > 0) nb.push(i - width);
    for (const j of nb) {
      if (!seen[j] && bgLike(j) && (diff(i, j) <= TOL || (neutral(i) && neutral(j)))) {
        seen[j] = 1;
        alpha[j] = 0;
        queue.push(j);
      }
    }
  }

  // мягкий край + despill magenta-каймы
  for (let i = 0; i < n; i++) {
    if (alpha[i] === 0) continue;
    const x = i % width, y = (i / width) | 0;
    const nb = [];
    if (x + 1 < width) nb.push(i + 1);
    if (x > 0) nb.push(i - 1);
    if (y + 1 < height) nb.push(i + width);
    if (y > 0) nb.push(i - width);
    for (const j of nb) {
      if (alpha[j] !== 0) continue;
      const dist = diff(i, j);
      if (dist <= SOFT) {
        const a = Math.max(0, Math.round(((dist - TOL) / (SOFT - TOL)) * 255));
        alpha[i] = Math.min(alpha[i], a);
      }
    }
    const d = i * 4;
    if (alpha[i] > 0 && alpha[i] < 255 && data[d] > data[d + 1] && data[d + 2] > data[d + 1]) {
      data[d] = Math.min(data[d], data[d + 1] + 30);
      data[d + 2] = Math.min(data[d + 2], data[d + 1] + 30);
    }
  }

  // водяной знак провайдера в правом нижнем углу — всегда фон, срезаем
  const x0 = Math.floor(width * 0.70);
  const y0 = Math.floor(height * 0.92);
  for (let y = y0; y < height; y++) {
    for (let x = x0; x < width; x++) {
      alpha[y * width + x] = 0;
    }
  }

  for (let i = 0; i < n; i++) {
    data[i * 4 + 3] = alpha[i];
  }
}

// провайдер иногда даёт letterbox-полосы (чёрные/белые) по краям тайла:
// срезаем однородные тёмные/светлые строки и столбцы перед даунскейлом
function trimLetterbox(img) {
  const { width, height, data } = img;
  // полоса = ≥90% пикселей строки/столбца тёмные (<60) или светлые (>230):
  // letterbox провайдера не идеально однороден, порог по большинству
  const rowUniform = (y) => {
    let dark = 0, light = 0;
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4;
      const l = (data[d] + data[d + 1] + data[d + 2]) / 3;
      if (l < 60) dark++;
      if (l > 230) light++;
    }
    return dark >= width * 0.9 || light >= width * 0.9;
  };
  const colUniform = (x) => {
    let dark = 0, light = 0;
    for (let y = 0; y < height; y++) {
      const d = (y * width + x) * 4;
      const l = (data[d] + data[d + 1] + data[d + 2]) / 3;
      if (l < 60) dark++;
      if (l > 230) light++;
    }
    return dark >= height * 0.9 || light >= height * 0.9;
  };
  let top = 0, bottom = height, left = 0, right = width;
  while (top < bottom - 8 && rowUniform(top)) top++;
  while (bottom > top + 8 && rowUniform(bottom - 1)) bottom--;
  while (left < right - 8 && colUniform(left)) left++;
  while (right > left + 8 && colUniform(right - 1)) right--;

  if (top === 0 && bottom === height && left === 0 && right === width) return img;

  const w = right - left, h = bottom - top;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((y + top) * width + (x + left)) * 4;
      const d = (y * w + x) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
    }
  }
  return { width: w, height: h, data: out };
}

// area-average даунскейл с premultiplied alpha (без тёмной каймы)
function downscale(img, size) {
  const { width, height, data } = img;
  const out = new Uint8ClampedArray(size * size * 4);
  const fx = width / size;
  const fy = height / size;

  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const x0 = Math.floor(tx * fx), x1 = Math.floor((tx + 1) * fx);
      const y0 = Math.floor(ty * fy), y1 = Math.floor((ty + 1) * fy);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const s = (y * width + x) * 4;
          const al = data[s + 3] / 255;
          r += data[s] * al; g += data[s + 1] * al; b += data[s + 2] * al;
          a += al; n++;
        }
      }
      const d = (ty * size + tx) * 4;
      if (a > 0) {
        out[d] = r / a; out[d + 1] = g / a; out[d + 2] = b / a;
      }
      out[d + 3] = (a / n) * 255;
    }
  }
  return { width: size, height: size, data: out };
}

// wrap-crossfade: левый/верхний край подмешивает правый/нижний,
// чтобы противоположные края сходились при тайлинге
function seamless(img) {
  const { width, height, data } = img;
  const at = (x, y) => (y * width + x) * 4;
  const mix = (d, s, t) => {
    for (let k = 0; k < 4; k++) {
      data[d + k] = data[d + k] * t + data[s + k] * (1 - t);
    }
  };
  for (let i = 0; i < SEAM; i++) {
    const t = (i + 1) / (SEAM + 1);
    for (let y = 0; y < height; y++) {
      mix(at(i, y), at(width - 1 - i, y), t);
    }
    for (let x = 0; x < width; x++) {
      mix(at(x, i), at(x, height - 1 - i), t);
    }
  }
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const manifest = {
    tile: TILE,
    terrain: {},
    props: {},
    units: { frames: FRAMES },
    footprint: 1
  };

  // отсутствующий raw (провайдер ещё не сгенерировал) — пропускаем:
  // рендер по такому ключу уйдёт в фолбэк, полный манифест соберётся позже
  const processOne = (id, isTile) => {
    const src = path.join(RAW_DIR, `${id}.png`);
    if (!fs.existsSync(src)) {
      console.log(`[skip] ${id} (нет raw)`);
      return false;
    }
    if (SKIP_IDS.has(id)) {
      console.log(`[defect] ${id} (брак провайдера, пропущен; перегенерировать)`);
      return false;
    }
    let img = decodePNG(fs.readFileSync(src));
    deWatermark(img, isTile);
    chromaKey(img, isTile);
    if (isTile) img = trimLetterbox(img);
    // gate контента: спрайт, потерявший центр после кейинга (провайдер
    // «растворил» арт в фоне), в манифест не берём — рендер уйдёт в фолбэк
    if (!isTile) {
      let clear = 0;
      for (let i = 3; i < img.data.length; i += 4) {
        if (img.data[i] < 128) clear++;
      }
      if (clear / (img.width * img.height) < MIN_TRANSPARENT) {
        console.log(`[defect] ${id} (фон не отделился, пропущен; перегенерировать)`);
        return false;
      }
      let opaque = 0, total = 0;
      const x0 = img.width >> 2, x1 = img.width - (img.width >> 2);
      const y0 = img.height >> 2, y1 = img.height - (img.height >> 2);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          total++;
          if (img.data[(y * img.width + x) * 4 + 3] > 128) opaque++;
        }
      }
      if (opaque / total < 0.2) {
        console.log(`[defect] ${id} (контент потерян при кейинге, пропущен)`);
        return false;
      }
    }
    const small = downscale(img, TILE);
    if (isTile) seamless(small);
    fs.writeFileSync(path.join(OUT_DIR, `${id}.png`), encodePNG(TILE, TILE, small.data));
    console.log(`[ok] ${id}`);
    return true;
  };

  for (const t of TERRAIN_IDS) {
    if (processOne(`terrain-${t}`, true)) manifest.terrain[t] = `terrain-${t}.png`;
  }
  for (const p of PROP_IDS) {
    if (processOne(`prop-${p}`, false)) manifest.props[p] = `prop-${p}.png`;
  }
  manifest.unitFrames = {};
  for (const u of Object.keys(UNIT_PROMPTS)) {
    // достаточно одного кадра: отсутствующие кадры рендер уводит в фолбэк
    const have = [];
    for (const f of FRAMES) {
      if (processOne(`unit-${u}-${f}`, false)) have.push(f);
    }
    if (have.length) {
      manifest.units[u] = `unit-${u}`;
      manifest.unitFrames[u] = have;
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`manifest.json записан (${TERRAIN_IDS.length} тайлов, ${PROP_IDS.length} props, ${Object.keys(UNIT_PROMPTS).length} юнитов x ${FRAMES.length} кадра)`);
}

main();
