import { AttackingBuilding } from "../base/index.js";

export class WatchTower extends AttackingBuilding {
	static readonly type = "watchTower";
	static readonly label = "Watch Tower";
	static readonly sprite = "watchTower";
	static readonly maxHp = 210;
	static readonly size = 1;
	static readonly score = 80;
	static readonly cost = { wood: 80, ore: 45 };
	static readonly vision = 11;
	static readonly sound = 0;
	static readonly attack = 14;
	static readonly attackRange = 5.5;
	static readonly attackCooldown = 1.4;
}
