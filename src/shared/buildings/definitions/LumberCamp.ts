import { DepotBuilding } from "../base/index.js";

export class LumberCamp extends DepotBuilding {
	static readonly type = "lumberCamp";
	static readonly label = "Lumber Camp";
	static readonly sprite = "lumberCamp";
	static readonly maxHp = 150;
	static readonly size = 1;
	static readonly score = 25;
	static readonly cost = { wood: 70 };
	static readonly vision = 5;
	static readonly sound = 0;
	static readonly accepts = ["wood"] as const;
}
