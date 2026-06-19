import { AttackingBuilding } from "../base/index.js";

export class WatchTower extends AttackingBuilding {
	static readonly type = "watchTower";
	static readonly label = "Watch Tower";
	static readonly sprite = "watchTower";
	static readonly maxHp = 850;
	static readonly size = 1;
	static readonly score = 80;
	static readonly cost = { wood: 35, ore: 125 };
	static readonly vision = 11;
	static readonly sound = 0;
	static readonly attack = 5;
	static readonly attackRange = 8;
	static readonly attackCooldown = 2;
}
