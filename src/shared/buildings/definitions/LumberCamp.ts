import { DepotBuilding } from "../base/index.js";

export class LumberCamp extends DepotBuilding {
	static readonly type = "lumberCamp";
	static readonly label = "Lumber Camp";
	static readonly description = "Drop-off point for wood. Build near forests to shorten villager trips.";
	static readonly sprite = "lumberCamp";
	static readonly maxHp = 600;
	static readonly size = 1;
	static readonly score = 25;
	static readonly cost = { wood: 100 };
	static readonly vision = 5;
	static readonly sound = 2;
	static readonly accepts = ["wood"] as const;
}
