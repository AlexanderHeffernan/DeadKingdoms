import { Building } from "../base/index.js";

export class House extends Building {
	static readonly type = "house";
	static readonly label = "House";
	static readonly sprite = "house";
	static readonly maxHp = 550;
	static readonly size = 2;
	static readonly score = 15;
	static readonly cost = { wood: 25 };
	static readonly vision = 5;
	static readonly sound = 0;
	static readonly populationCapacity = 5;
}
