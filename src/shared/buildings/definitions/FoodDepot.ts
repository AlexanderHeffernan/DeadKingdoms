import { DepotBuilding } from "../base/index.js";

export class FoodDepot extends DepotBuilding {
	static readonly type = "foodDepot";
	static readonly label = "Mill";
	static readonly description = "Drop-off point for food. Build near berries or farms to shorten villager trips.";
	static readonly sprite = "foodDepot";
	static readonly maxHp = 600;
	static readonly size = 1;
	static readonly score = 25;
	static readonly cost = { wood: 100 };
	static readonly vision = 5;
	static readonly sound = 2;
	static readonly accepts = ["food"] as const;
}
