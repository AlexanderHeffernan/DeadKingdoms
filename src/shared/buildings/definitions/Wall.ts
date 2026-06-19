import { Building } from "../base/index.js";

export class Wall extends Building {
	static readonly type = "wall";
	static readonly label = "Wall";
	static readonly sprite = "wall";
	static readonly maxHp = 180;
	static readonly size = 1;
	static readonly score = 20;
	static readonly cost = { wood: 8 };
	static readonly vision = 1;
	static readonly sound = 0;
}
