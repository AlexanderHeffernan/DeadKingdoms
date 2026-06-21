import { ArcherUnit, ScoutUnit, SoldierUnit, VillagerUnit, ZombieUnit } from "./units/index.js";
import type { UnitBehavior, UnitClass } from "./units/index.js";
import type { UnitType } from "./types.js";

export const UNIT_CLASSES = [
	VillagerUnit,
	SoldierUnit,
	ArcherUnit,
	ScoutUnit,
	ZombieUnit,
] as const;

const UNIT_CLASS_BY_TYPE = Object.fromEntries(UNIT_CLASSES.map((Unit) => [Unit.type, Unit])) as Record<UnitType, UnitClass>;

export function unitClassFor(type: UnitType): UnitClass {
	return UNIT_CLASS_BY_TYPE[type];
}

export function unitBehaviorFor(type: UnitType): UnitBehavior {
	return new (unitClassFor(type))();
}

export function allUnitClasses(): readonly UnitClass[] {
	return UNIT_CLASSES;
}
