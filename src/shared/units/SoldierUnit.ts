import { BaseUnit } from "./BaseUnit.js";

export class SoldierUnit extends BaseUnit {
	public static readonly type = "soldier";
	public static readonly label = "Soldier";
	public static readonly sprite = "soldier";
	public static readonly trainShortcut = "S";
	public static readonly maxHp = 40;
	public static readonly speed = 4.1;
	public static readonly attack = 4;
	public static readonly range = 1.05;
	public static readonly cooldown = 2;
	public static readonly score = 25;
	public static readonly trainTime = 10.5;
	public static readonly cost = { food: 50, ore: 20 };
	public static readonly vision = 12;
	public static readonly sound = 8;
	public static readonly canAutoAcquireTargets = true;
}
