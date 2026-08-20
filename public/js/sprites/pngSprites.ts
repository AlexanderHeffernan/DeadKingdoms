import houseBase from "./house_base.png";
import houseFlag from "./house_flag.png";
import watchTowerBase from "./watch_tower_base.png";
import watchTowerFlag from "./watch_tower_flag.png";

import rock from "./rock.png";
import pine from "./pine.png";
import berryBush from "./berry_bush.png";

import townCenterBase from "./town_centre_base_v2.png";
import townCenterFlag from "./town_centre_flag_v2.png";

import soldierBase from "./soldier_base.png";
import soldierFlag from "./soldier_flag.png";
import villagerBase from "./villager_base.png";
import villagerFlag from "./villager_flag.png";
import zombieDef from "./zombie_def.png";
import zombieVil from "./zombie_vil.png";
import zombieSol from "./zombie_sol.png";
import pillarBase from "./pillar_base.png";
import pillarFlag from "./pillar_flag.png";
import pillarConnected from "./C_pillar_base.png";
import pillarLeftConnected from "./LC_pillar_base.png";
import pillarRightConnected from "./RC_pillar_base.png";
import wallFtoB from "./wall_FtoB.png";
import wallBtoF from "./wall_BtoF.png";
import wallHori from "./wall_hori.png";
import wallVerti from "./wall_verti.png";
import gateFtoBBase from "./gate_FtoB_base.png";
import gateFtoBFlag from "./gate_FtoB_flag.png";
import gateBtoFBase from "./gate_BtoF_base.png";
import gateBtoFFlag from "./gate_BtoF_flag.png";
import gateHoriBase from "./gate_hori_base.png";
import gateHoriFlag from "./gate_hori_flag.png";
import gateVertiBase from "./gate_verti_base.png";
import gateVertiFlag from "./gate_verti_flag.png";

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
  flagLayer?: "under" | "over";
  width: number;
  height: number;
};

export const pngSprites: Partial<Record<SpriteName, PngSprite>> = {
  house: { base: houseBase, flag: houseFlag, width: 32, height: 32 },
  watchTower: { base: watchTowerBase, flag: watchTowerFlag, flagLayer: "over", width: 24, height: 56 },
  ore: { base: rock, width: 16, height: 16 },
  tree: { base: pine, width: 16, height: 24 },
  berry: { base: berryBush, width: 16, height: 16 },
  townCenter: { base: townCenterBase, flag: townCenterFlag, width: 64, height: 64 },
  soldier: { base: soldierBase, flag: soldierFlag, width: 16, height: 16 },
  villager: { base: villagerBase, flag: villagerFlag, width: 16, height: 16 },
  zombie: { base: zombieDef, width: 16, height: 16 },
  zombie_def: { base: zombieDef, width: 16, height: 16 },
  zombie_vil: { base: zombieVil, width: 16, height: 16 },
  zombie_sol: { base: zombieSol, width: 16, height: 16 },
  pillarBase: { base: pillarBase, flag: pillarFlag, width: 16, height: 24 },
  pillarConnected: { base: pillarConnected, flag: pillarFlag, width: 16, height: 24 },
  pillarLeftConnected: { base: pillarLeftConnected, flag: pillarFlag, width: 16, height: 24 },
  pillarRightConnected: { base: pillarRightConnected, flag: pillarFlag, width: 16, height: 24 },
  wallFtoB: { base: wallFtoB, width: 16, height: 24 },
  wallBtoF: { base: wallBtoF, width: 16, height: 24 },
  wallHori: { base: wallHori, width: 16, height: 24 },
  wallVerti: { base: wallVerti, width: 16, height: 24 },
  gate: { base: gateFtoBBase, flag: gateFtoBFlag, flagLayer: "over", width: 16, height: 24 },
  gateFtoB: { base: gateFtoBBase, flag: gateFtoBFlag, flagLayer: "over", width: 16, height: 24 },
  gateBtoF: { base: gateBtoFBase, flag: gateBtoFFlag, flagLayer: "over", width: 16, height: 24 },
  gateHori: { base: gateHoriBase, flag: gateHoriFlag, flagLayer: "over", width: 16, height: 24 },
  gateVerti: { base: gateVertiBase, flag: gateVertiFlag, flagLayer: "over", width: 16, height: 24 }
};
