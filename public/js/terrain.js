export const MAP_SIZE = 16;

// Типы местности
export const TERRAIN = {
  GRASS: 0,
  FOREST: 1,
  HILL: 2,
  WATER: 3,
  MOUNTAIN: 4,
  VILLAGE: 5,
  CASTLE: 6
};

// Ключи перевода для местности
export const TERRAIN_KEYS = {
  [TERRAIN.GRASS]: "grass",
  [TERRAIN.FOREST]: "forest",
  [TERRAIN.HILL]: "hill",
  [TERRAIN.WATER]: "water",
  [TERRAIN.MOUNTAIN]: "mountain",
  [TERRAIN.VILLAGE]: "village",
  [TERRAIN.CASTLE]: "castle"
};

// Цвета для типов местности
export const TERRAIN_COLORS = {
  [TERRAIN.GRASS]: "#7bb546",
  [TERRAIN.FOREST]: "#3e7c36",
  [TERRAIN.HILL]: "#a3925a",
  [TERRAIN.WATER]: "#3f76c4",
  [TERRAIN.MOUNTAIN]: "#7a7a7a",
  [TERRAIN.VILLAGE]: "#d7a84e",
  [TERRAIN.CASTLE]: "#9a5fd0"
};

// Стоимость движения по местности
export const TERRAIN_COST = {
  [TERRAIN.GRASS]: 1,
  [TERRAIN.FOREST]: 2,
  [TERRAIN.HILL]: 2,
  [TERRAIN.WATER]: Infinity,
  [TERRAIN.MOUNTAIN]: Infinity,
  [TERRAIN.VILLAGE]: 1,
  [TERRAIN.CASTLE]: 1
};

// Бонусы защиты местности
export const TERRAIN_DEFENSE = {
  [TERRAIN.GRASS]: 0,
  [TERRAIN.FOREST]: 5,
  [TERRAIN.HILL]: 8,
  [TERRAIN.WATER]: 0,
  [TERRAIN.MOUNTAIN]: 0,
  [TERRAIN.VILLAGE]: 8,
  [TERRAIN.CASTLE]: 20
};