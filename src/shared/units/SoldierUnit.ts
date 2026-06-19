import { BaseUnit } from "./BaseUnit.js";

export class SoldierUnit extends BaseUnit {
	public static readonly type = "soldier";
	public static readonly label = "Soldier";
	public static readonly sprite = "soldier";
	public static readonly trainShortcut = "S";
	public static readonly maxHp = 70;
	public static readonly speed = 4.1;
	public static readonly attack = 9;
	public static readonly range = 1.05;
	public static readonly cooldown = 0.8;
	public static readonly score = 25;
	public static readonly trainTime = 8;
	public static readonly cost = { food: 45, ore: 20 };
	public static readonly vision = 7;
	public static readonly sound = 8;
	public static readonly canAutoAcquireTargets = true;
}
