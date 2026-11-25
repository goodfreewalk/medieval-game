// Загрузка спрайтов графики v2 (только клиент).
// manifest.json + PNG; целочисленная предрасстеризация 2x/3x (nearest).

const BASE = "assets/sprites/";

let manifest = null;
let readyPromise = null;
const rasters = new Map();
const tintCache = new Map();

function rasterize(img) {
  const make = (k) => {
    const c = document.createElement("canvas");
    c.width = img.width * k;
    c.height = img.height * k;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  };
  return { c2: make(2), c3: make(3) };
}

function loadFile(file) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      rasters.set(file, rasterize(img));
      resolve();
    };
    // битый/отсутствующий файл не валит игру: рендер уйдёт в фолбэк
    img.onerror = () => resolve();
    img.src = BASE + file;
  });
}

export function loadSprites() {
  if (readyPromise) {
    return readyPromise;
  }

  readyPromise = fetch(BASE + "manifest.json")
    .then(r => {
      if (!r.ok) throw new Error("manifest HTTP " + r.status);
      return r.json();
    })
    .then(m => {
      const files = [...Object.values(m.terrain), ...Object.values(m.props)];
      for (const [key, base] of Object.entries(m.units)) {
        if (key === "frames") continue;
        // только доступные кадры: запрос отсутствующего файла дал бы 404 в консоли
        const frames = (m.unitFrames && m.unitFrames[key]) || m.units.frames;
        for (const f of frames) files.push(`${base}-${f}.png`);
      }
      return Promise.all(files.map(loadFile)).then(() => {
        manifest = m;
        return true;
      });
    })
    .catch(() => false);

  return readyPromise;
}

export function spritesReady() {
  return manifest !== null;
}

// integer-scale: 3x-растр для крупных клеток, иначе 2x; вывод nearest
export function pick(r, screen) {
  return screen > 96 ? r.c3 : r.c2;
}

export function terrainRaster(key) {
  return rasters.get(manifest?.terrain[key]);
}

export function propRaster(key) {
  return rasters.get(manifest?.props[key]);
}

export function unitRaster(key, frame) {
  const base = manifest?.units[key];
  if (!base) return undefined;
  const frames = (manifest.unitFrames && manifest.unitFrames[key]) || manifest.units.frames;
  // запрошенный кадр, затем любой доступный (частичный манифест)
  for (const f of [frame, ...frames.filter(x => x !== frame)]) {
    const r = rasters.get(`${base}-${f}.png`);
    if (r) return r;
  }
  return undefined;
}

// Флаг владельца: баннер тонируется multiply в цвет игрока,
// destination-in возвращает альфу исходного спрайта
export function bannerRaster(color) {
  const src = propRaster("banner");
  if (!src) return null;

  let c = tintCache.get(color);
  if (c) return c;

  c = document.createElement("canvas");
  c.width = src.c2.width;
  c.height = src.c2.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(src.c2, 0, 0);
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(src.c2, 0, 0);

  tintCache.set(color, c);
  return c;
}
