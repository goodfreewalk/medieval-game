// Диспетчер рендера: по умолчанию пиксельный (графика v2),
// старый эмодзи-рендер — за флагом ?renderer=legacy до приёмки.

import { drawGame as drawLegacy } from "./render/legacy.js";
import { drawGame as drawPixel, notifyAttack } from "./render/pixel.js";

const LEGACY =
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).get("renderer") === "legacy";

export function drawGame() {
  if (LEGACY) {
    drawLegacy();
  } else {
    drawPixel();
  }
}

export { notifyAttack };
