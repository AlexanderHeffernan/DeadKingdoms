import { BaseUnit } from "./BaseUnit.js";

export class SoldierUnit extends BaseUnit {
	public static readonly type = "soldier";
	public static readonly label = "Soldier";
	public static readonly sprite = "soldier";
	public static readonly trainShortcut = "S";
	public static readonly stats = {
		maxHp: 70,
		speed: 4.1,
		attack: 9,
		range: 1.05,
		cooldown: 0.8,
		score: 18,
		trainTime: 8,
		cost: { food: 45, ore: 20 },
		vision: 7,
		sound: 1.8,
	} as const;

	public canAutoAcquireTargets() {
		return true;
	}
}
