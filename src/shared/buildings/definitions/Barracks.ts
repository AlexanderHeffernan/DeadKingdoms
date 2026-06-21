import { ProductionBuilding } from "../base/index.js";
import { ArcherUnit, ScoutUnit, SoldierUnit } from "../../units/index.js";

export class Barracks extends ProductionBuilding {
	static readonly type = "barracks";
	static readonly label = "Barracks";
	static readonly sprite = "barracks";
	static readonly maxHp = 1200;
	static readonly size = 3;
	static readonly score = 90;
	static readonly cost = { wood: 175 };
	static readonly vision = 6;
	static readonly sound = 0;
	static readonly trains = [SoldierUnit, ArcherUnit, ScoutUnit] as const;
}
