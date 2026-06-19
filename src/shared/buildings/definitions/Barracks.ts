import { ProductionBuilding } from "../base/index.js";
import { SoldierUnit } from "../../units/index.js";

export class Barracks extends ProductionBuilding {
	static readonly type = "barracks";
	static readonly label = "Barracks";
	static readonly sprite = "barracks";
	static readonly maxHp = 260;
	static readonly size = 3;
	static readonly score = 90;
	static readonly cost = { wood: 120, ore: 30 };
	static readonly vision = 6;
	static readonly sound = 0;
	static readonly trains = [SoldierUnit] as const;
}
