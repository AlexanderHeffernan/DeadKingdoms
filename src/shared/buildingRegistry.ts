import {
  Barracks,
  Farm,
  FoodDepot,
  House,
  LumberCamp,
  MiningCamp,
  TownCenter,
  WatchTower,
} from "./buildingDefinitions.js";
import type { BuildingEntity, BuildingInit, BuildingSnapshot } from "./buildingDefinitions.js";
import type { BuildingType } from "./types.js";

export const BUILDING_CLASSES = {
  townCenter: TownCenter,
  house: House,
  barracks: Barracks,
  watchTower: WatchTower,
  farm: Farm,
  lumberCamp: LumberCamp,
  foodDepot: FoodDepot,
  miningCamp: MiningCamp,
} as const;

export const BUILDING_DEFS = Object.fromEntries(
  Object.entries(BUILDING_CLASSES).map(([type, BuildingClass]) => {
    const sample = new BuildingClass({ id: `${type}:sample`, ownerId: "sample", x: 0, y: 0 });
    return [type, sample];
  }),
) as {
  [K in keyof typeof BUILDING_CLASSES]: InstanceType<(typeof BUILDING_CLASSES)[K]>;
};

export function buildingClassFor(type: BuildingType): new (init: BuildingInit) => BuildingEntity {
  return BUILDING_CLASSES[type];
}

export function createBuildingEntity(type: BuildingType, init: BuildingInit): BuildingEntity {
  const BuildingClass = buildingClassFor(type);
  return new BuildingClass(init);
}

/** Restores a runtime building class instance from JSON-safe network data. */
export function deserializeBuilding(snapshot: BuildingSnapshot): BuildingEntity {
  const building = createBuildingEntity(snapshot.type, snapshot);
  Object.assign(building, snapshot);
  return building;
}
