import { DepotBuilding } from "../base/index.js";

export class MiningCamp extends DepotBuilding {
	static readonly type = "miningCamp";
	static readonly label = "Mining Camp";
	static readonly sprite = "miningCamp";
	static readonly maxHp = 600;
	static readonly size = 1;
	static readonly score = 25;
	static readonly cost = { wood: 100 };
	static readonly vision = 5;
	static readonly sound = 0;
	static readonly accepts = ["ore"] as const;
}
