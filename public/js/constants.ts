import { BUILDING_TYPES } from "../../src/shared/buildings/index.js";
import type { UnitType } from "../../src/shared/types.js";
import type { UnitClass } from "../../src/shared/units/index.js";

export const TILE_W = 64;
export const TILE_H = 32;
export const SCALE = 4;

export const BUILDINGS = Object.fromEntries(
	Object.entries(BUILDING_TYPES)
		.filter(([buildingType]) => buildingType !== "townCenter")
		.map(([buildingType, building]) => [buildingType, { label: building.label, cost: building.cost }]),
) as Record<string, { label: string; cost: Record<string, number> }>;

export const TRAINING = {
	...Object.fromEntries(
		Object.entries(BUILDING_TYPES)
			.filter(([, building]) => "trains" in building)
			.map(([buildingType, building]) => [
				buildingType,
				((building as { trains: readonly UnitClass[] }).trains).map((Unit) => {
					return {
						unitType: Unit.type,
						label: Unit.label,
						cost: Unit.cost,
						shortcut: Unit.trainShortcut,
					};
				}),
			]),
	),
} as Record<string, { unitType: UnitType; label: string; cost: Record<string, number>; shortcut?: string }[]>;
