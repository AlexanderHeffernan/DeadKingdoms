import { BaseUnit } from "./BaseUnit.js";
import type { UnitSimulationContext } from "./BaseUnit.js";
import type { Unit } from "../types.js";

export class ScoutUnit extends BaseUnit {
	public static readonly type = "scout";
	public static readonly label = "Scout";
	public static readonly sprite = "scout";
	public static readonly trainShortcut = "C";
	public static readonly maxHp = 18;
	public static readonly speed = 5.6;
	public static readonly attack = 0;
	public static readonly range = 0.8;
	public static readonly cooldown = 0;
	public static readonly score = 22;
	public static readonly trainTime = 8;
	public static readonly cost = { food: 200 };
	public static readonly vision = 18;
	public static readonly sound = 1;

	public step(context: UnitSimulationContext, unit: Unit, dt: number) {
		if (unit.hornActive && unit.command.type === "move") unit.hornActive = false;
		if (unit.hornActive) {
			context.emitActionSound("horn", unit);
			unit.workFlash = Math.max(unit.workFlash || 0, 0.25);
		}
		super.step(context, unit, dt);
	}

	public onAttacked(_context: Pick<UnitSimulationContext, "setCommand">, unit: Unit) {
		unit.hornActive = false;
	}
}
