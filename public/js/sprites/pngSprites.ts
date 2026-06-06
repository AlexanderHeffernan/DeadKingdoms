import houseBase from "./house_base.png";
import houseFlag from "./house_flag.png";

import rock from "./rock.png";
import pine from "./pine.png";
import berryBush from "./berry_bush.png";

import townCenterBase from "./town_centre_base_v2.png";
import townCenterFlag from "./town_centre_flag_v2.png";

import soldierBase from "./soldier_base.png";
import soldierFlag from "./soldier_flag.png";

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
  tree: { base: pine, width: 16, height: 24 },
  berry: { base: berryBush, width: 16, height: 16 },
  townCenter: { base: townCenterBase, flag: townCenterFlag, width: 64, height: 64 },
  soldier: { base: soldierBase, flag: soldierFlag, width: 16, height: 16 }
};
