// Каталог ассетов графики v2: один ассет = один запрос к провайдеру.
// kind: "tile" — бесшовный full-bleed тайл; "sprite" — спрайт на magenta-фоне.

export const SUFFIX_SPRITE =
  "single game sprite, centered, solid magenta #FF00FF background, no baked shadow, 16-bit pixel art style";
export const SUFFIX_TILE =
  "seamless top-down terrain tile, full-bleed edge-to-edge, no sky, no horizon, 16-bit pixel art style";

// Позы кадров анимации (отдельные генерации)
export const FRAME_POSES = {
  walkA: "walking contact pose, legs spread mid-stride, weapon ready",
  walkB: "walking passing pose, legs together under the body, weapon ready",
  attack: "attack pose, weapon swung forward striking, dynamic lunge"
};

const TERRAIN_PROMPTS = {
  grass: "green grass meadow ground texture",
  forest: "dense green forest tree canopy ground texture",
  hills: "dry yellow-brown hills dirt ground texture",
  water: "blue river water surface texture",
  mountain: "grey rocky mountain stone ground texture"
};

const PROP_PROMPTS = {
  castle: "medieval stone castle with two towers and a gate, three-quarter top-down view",
  village: "small medieval village with four houses and a wooden fence, three-quarter top-down view",
  banner: "small medieval heraldic banner flag on a short pole, plain light cloth",
  gold: "small pile of shiny gold coins"
};

// Ключи манифеста → описание юнита (вид сбоку, смотрит вправо)
export const UNIT_PROMPTS = {
  axe: "foot warrior with a battle axe, leather armor",
  archer: "foot archer with a bow and quiver",
  knight: "foot knight with sword and shield, chainmail",
  spear: "rider on a brown horse holding a spear",
  heavy: "armored rider on a black horse with a sword",
  marcher: "rider on a brown horse drawing a bow"
};

export const ASSETS = [];

// усиление базы промпта: провайдер игнорирует часть суффикса (рамки, белый фон)
const TILE_REINFORCE =
  "uniform natural ground texture, no border, no frame, no ornamental pattern, no text, no watermark";
const SPRITE_REINFORCE =
  "plain flat bright magenta background, no text, no watermark";

for (const [id, prompt] of Object.entries(TERRAIN_PROMPTS)) {
  ASSETS.push({ id: `terrain-${id}`, kind: "tile", prompt: `${prompt}, ${TILE_REINFORCE}, ${SUFFIX_TILE}` });
}

for (const [id, prompt] of Object.entries(PROP_PROMPTS)) {
  ASSETS.push({ id: `prop-${id}`, kind: "sprite", prompt: `${prompt}, ${SPRITE_REINFORCE}, ${SUFFIX_SPRITE}` });
}

for (const [id, prompt] of Object.entries(UNIT_PROMPTS)) {
  for (const [frame, pose] of Object.entries(FRAME_POSES)) {
    ASSETS.push({
      id: `unit-${id}-${frame}`,
      kind: "sprite",
      prompt: `${prompt}, ${pose}, side view facing right, ${SPRITE_REINFORCE}, ${SUFFIX_SPRITE}`
    });
  }
}
