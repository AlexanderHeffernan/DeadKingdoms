import { Building, type BuildingInit, type BuildingSnapshot } from "../base/index.js";
import type { PlayerId, ResourceCost } from "../../types.js";

export class Farm extends Building {
	static readonly type = "farm";
	static readonly label = "Farm";
	static readonly sprite = "farm";
	static readonly maxHp = 480;
	static readonly size = 4;
	static readonly score = 20;
	static readonly cost = { wood: 60 };
	static readonly vision = 3;
	static readonly sound = 0;
	static readonly walkBlocking = false;
	static readonly gatherResource = "food";
	static readonly gatherAmount = 8;
	static readonly gatherSeconds = 20;
	static readonly gatherRange = 2;
	static readonly shouldGatherAfterBuild = true;
	static readonly replenishCost = { wood: 60 } as const;
	amount: number;
	maxAmount: number;
	resource: "food";
	exhausted: boolean;

	constructor(init: BuildingInit) {
		super(init);
		this.amount = 160;
		this.maxAmount = 160;
		this.resource = "food";
		this.exhausted = false;
	}

	canBeGatheredBy(playerId: PlayerId) {
		return this.ownerId === playerId && this.isComplete();
	}

	get gatherExhausted() {
		return (this.amount ?? 0) <= 0;
	}

	onGatheredOut() {
		this.exhausted = this.gatherExhausted;
	}

	maybeReplenish(spend: (cost: ResourceCost) => boolean, autoReplenish: boolean) {
		if (!autoReplenish || (this.amount ?? 0) > 0 || !spend(Farm.replenishCost)) return false;
		this.amount = this.maxAmount || 160;
		this.exhausted = false;
		return true;
	}

	protected serializeExtra(): Partial<BuildingSnapshot> {
		return {
			...super.serializeExtra(),
			amount: this.amount,
			maxAmount: this.maxAmount,
			resource: this.resource,
			exhausted: this.exhausted,
		};
	}
}
