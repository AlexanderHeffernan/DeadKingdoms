import { Building } from "../base/index.js";

export class Wall extends Building {
	static readonly type = "wall";
	static readonly label = "Wall";
	static readonly description = "Blocks enemy movement and protects your settlement.";
	static readonly sprite = "wall";
	static readonly maxHp = 1080;
	static readonly size = 1;
	static readonly score = 20;
	static readonly cost = { ore: 5 };
	static readonly vision = 1;
	static readonly sound = 0;
}
