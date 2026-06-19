import { Building } from "../base/index.js";

export class Gate extends Building {
	static readonly type = "gate";
	static readonly label = "Gate";
	static readonly sprite = "gate";
	static readonly maxHp = 260;
	static readonly size = 1;
	static readonly score = 45;
	static readonly cost = { wood: 32 };
	static readonly vision = 1;
	static readonly sound = 0;
}
