import { BaseUnit } from "./BaseUnit.js";

export class ArcherUnit extends BaseUnit {
	public static readonly type = "archer";
	public static readonly label = "Archer";
	public static readonly sprite = "archer";
	public static readonly trainShortcut = "A";
	public static readonly maxHp = 26;
	public static readonly speed = 4.5;
	public static readonly attack = 3;
	public static readonly range = 6;
	public static readonly cooldown = 2.4;
	public static readonly score = 25;
	public static readonly trainTime = 10.5;
	public static readonly cost = { wood: 35, food: 45 };
	public static readonly vision = 12;
	public static readonly sound = 4;
	public static readonly canAutoAcquireTargets = true;
}
