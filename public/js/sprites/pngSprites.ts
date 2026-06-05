import houseBase from "./house_base.png";
import houseFlag from "./house_flag.png";

import rock from "./rock.png";

import type { SpriteName } from "../../../src/shared/types.js";

// PNG-based sprites. Each sprite is composited from up to two layers:
//   - `flag`: a white mask that is tinted to the owning player's colour and
//     drawn UNDERNEATH the base layer.
//   - `base`: the main artwork, drawn on top at full colour.
// `width`/`height` are the source pixel dimensions; the renderer scales them by
// the world pixel size so they line up with the existing ascii sprites.
export type PngSprite = {
  base: string;
  flag?: string;
  width: number;
  height: number;
};

export const pngSprites: Partial<Record<SpriteName, PngSprite>> = {
  house: { base: houseBase, flag: houseFlag, width: 32, height: 32 },
  ore: { base: rock, width: 16, height: 16 },
};
