import { Building } from "../base/index.js";

export class Gate extends Building {
	static readonly type = "gate";
	static readonly label = "Gate";
	static readonly description = "Replaces one of your walls with a passable gate for your units.";
	static readonly sprite = "gate";
	static readonly maxHp = 1650;
	static readonly size = 1;
	static readonly score = 45;
	static readonly cost = { ore: 30 };
	static readonly vision = 1;
	static readonly sound = 0;
}
