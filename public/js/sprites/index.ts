import barracks from "./barracks.js";
import berry from "./berry.js";
import corpse from "./corpse.js";
import farm from "./farm.js";
import foodDepot from "./foodDepot.js";
import gate from "./gate.js";
import house from "./house.js";
import lumberCamp from "./lumberCamp.js";
import miningCamp from "./miningCamp.js";
import ore from "./ore.js";
import ruin from "./ruin.js";
import soldier from "./soldier.js";
import stump from "./stump.js";
import townCenter from "./townCenter.js";
import tree from "./tree.js";
import villager from "./villager.js";
import wall from "./wall.js";
import wallNorthEast from "./wallNorthEast.js";
import wallNorthWest from "./wallNorthWest.js";
import wallPillar from "./wallPillar.js";
import wallSouthEast from "./wallSouthEast.js";
import wallSouthWest from "./wallSouthWest.js";
import watchTower from "./watchTower.js";
import zombie from "./zombie.js";

import type { SpriteName } from "../../../src/shared/types.js";

export const sprites: Record<SpriteName, readonly string[]> = {
  barracks,
  berry,
  corpse,
  farm,
  foodDepot,
  gate,
  house,
  lumberCamp,
  miningCamp,
  ore,
  ruin,
  soldier,
  stump,
  townCenter,
  tree,
  villager,
  wall,
  wallNorthEast,
  wallNorthWest,
  wallPillar,
  wallSouthEast,
  wallSouthWest,
  watchTower,
  zombie,
  zombie_def: zombie,
  zombie_vil: zombie,
  zombie_sol: zombie,
} as const;
