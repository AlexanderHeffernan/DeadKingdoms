import { BUILDING_DEFS, UNIT_DEFS } from "../../src/shared/config.js";

export const TILE_W = 64;
export const TILE_H = 32;
export const SCALE = 4;

export const BUILDINGS = {
  house: { label: "House", cost: { wood: 35 } },
  farm: { label: "Farm", cost: { wood: 45 } },
  barracks: { label: "Barracks", cost: { wood: 120, ore: 30 } },
  watchTower: { label: "Watch Tower", cost: { wood: 80, ore: 45 } },
  lumberCamp: { label: "Lumber Camp", cost: { wood: 70 } },
  foodDepot: { label: "Food Depot", cost: { wood: 70 } },
  miningCamp: { label: "Mining Camp", cost: { wood: 70 } },
} as const;

export const TRAINING = {
  ...Object.fromEntries(
    Object.entries(BUILDING_DEFS)
      .filter(([, building]) => "trains" in building)
      .map(([buildingType, building]) => [
        buildingType,
        (building as { trains: readonly (keyof typeof UNIT_DEFS)[] }).trains.map((unitType) => {
          const unit = UNIT_DEFS[unitType];
          return {
            unitType,
            label: unit.label,
            cost: unit.stats.cost,
            shortcut: unit.trainShortcut,
          };
        }),
      ]),
  ),
} as Record<string, { unitType: keyof typeof UNIT_DEFS; label: string; cost: Record<string, number>; shortcut?: string }[]>;
