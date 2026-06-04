import { BUILDING_DEFS } from "../../src/shared/buildingRegistry.js";
import type { UnitType } from "../../src/shared/types.js";

export const TILE_W = 64;
export const TILE_H = 32;
export const SCALE = 4;

export const BUILDINGS = Object.fromEntries(
  Object.entries(BUILDING_DEFS)
    .filter(([buildingType]) => buildingType !== "townCenter")
    .map(([buildingType, building]) => [buildingType, { label: building.label, cost: building.stats.cost }]),
) as Record<string, { label: string; cost: Record<string, number> }>;

export const TRAINING = {
  ...Object.fromEntries(
    Object.entries(BUILDING_DEFS)
      .filter(([, building]) => building.trainableUnits().length > 0)
      .map(([buildingType, building]) => [
        buildingType,
        building.trainableUnitClasses().map((Unit) => {
          return {
            unitType: Unit.type,
            label: Unit.label,
            cost: Unit.stats.cost,
            shortcut: Unit.trainShortcut,
          };
        }),
      ]),
  ),
} as Record<string, { unitType: UnitType; label: string; cost: Record<string, number>; shortcut?: string }[]>;
