import { DepotBuilding } from "../base/index.js";

export class FoodDepot extends DepotBuilding {
	static readonly type = "foodDepot";
	static readonly label = "Food Depot";
	static readonly sprite = "foodDepot";
	static readonly maxHp = 150;
	static readonly size = 1;
	static readonly score = 25;
	static readonly cost = { wood: 70 };
	static readonly vision = 5;
	static readonly sound = 0;
	static readonly accepts = ["food"] as const;
}
