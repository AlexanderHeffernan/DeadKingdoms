import { sprites } from "./index.js";
import { pngSprites } from "./pngSprites.js";
import { spriteBounds } from "../spriteBounds.js";

import type { SpriteName } from "../../../src/shared/types.js";

// Returns the pixel bounds of a sprite regardless of whether it is an ascii
// sprite or a PNG sprite, so rendering and hit-testing stay in sync.
export function spriteMetrics(spriteName: SpriteName) {
  const png = pngSprites[spriteName];
  if (png) return { minX: 0, minY: 0, maxX: png.width - 1, maxY: png.height - 1, width: png.width, height: png.height };
  return spriteBounds(sprites[spriteName] || sprites.house);
}
