import { ProductionDepotBuilding } from "../base/index.js";
import { VillagerUnit } from "../../units/index.js";

export class TownCenter extends ProductionDepotBuilding {
	static readonly type = "townCenter";
	static readonly label = "Town Center";
	static readonly sprite = "townCenter";
	static readonly maxHp = 520;
	static readonly size = 4;
	static readonly score = 150;
	static readonly cost = { wood: 0 };
	static readonly vision = 8;
	static readonly sound = 0;
	static readonly populationCapacity = 4;
	static readonly trains = [VillagerUnit] as const;
	static readonly accepts = ["wood", "food", "ore"] as const;
}
