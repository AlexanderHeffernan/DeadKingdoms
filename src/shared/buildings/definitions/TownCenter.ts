import { ProductionDepotBuilding } from "../base/index.js";
import { VillagerUnit } from "../../units/index.js";

export class TownCenter extends ProductionDepotBuilding {
	static readonly type = "townCenter";
	static readonly label = "Town Center";
	static readonly description = "Central base, resource drop-off, and villager training building.";
	static readonly sprite = "townCenter";
	static readonly maxHp = 2400;
	static readonly size = 4;
	static readonly score = 150;
	static readonly cost = { wood: 300 };
	static readonly vision = 16;
	static readonly sound = 6;
	static readonly populationCapacity = 5;
	static readonly trains = [VillagerUnit] as const;
	static readonly accepts = ["wood", "food", "ore"] as const;

	override get manuallyDeletable() { return false; }
}
