import type { ResourceCost, ResourceType, UnitType } from "../../types.js";
import type { UnitBehavior, UnitClass } from "../../units/index.js";
import type { BuildingClass, BuildingEntity, BuildingInit, BuildingSnapshot } from "./types.js";

export abstract class Building implements BuildingEntity {
	readonly id;
	readonly kind = "building";
	readonly ownerId;
	x;
	y;
	hp;
	builderIds = [];
	invincible?: boolean;

	constructor(init: BuildingInit) {
		this.id = init.id;
		this.ownerId = init.ownerId;
		this.x = Math.round(init.x);
		this.y = Math.round(init.y);
		this.hp = init.hp ?? this.maxHp;
	}

	get type() { return this.definition.type; }
	get label() { return this.definition.label; }
	get sprite() { return this.definition.sprite; }
	get maxHp() { return this.definition.maxHp; }
	get size() { return this.definition.size; }
	get score() { return this.definition.score; }
	get cost() { return this.definition.cost; }
	get vision() { return this.definition.vision; }
	get sound() { return this.definition.sound; }
	get walkBlocking() { return this.definition.walkBlocking ?? true; }
	get populationCapacity() { return this.definition.populationCapacity ?? 0; }
	get gatherResource() { return this.definition.gatherResource ?? null; }
	get gatherAmount() { return this.definition.gatherAmount ?? 0; }
	get gatherSeconds() { return this.definition.gatherSeconds ?? 0; }
	get gatherRange() { return this.definition.gatherRange ?? 1.1; }
	get gatherExhausted() { return true; }
	get shouldGatherAfterBuild() { return this.definition.shouldGatherAfterBuild ?? false; }
	get canAttack() { return false; }
	get attack() { return 0; }
	get attackRange() { return 0; }
	get attackCooldown() { return 0; }

	private get definition() {
		return this.constructor as unknown as BuildingClass;
	}

	serialize(): BuildingSnapshot {
		return {
			id: this.id,
			kind: this.kind,
			type: this.type,
			ownerId: this.ownerId,
			x: this.x,
			y: this.y,
			size: this.size,
			hp: this.hp,
			maxHp: this.maxHp,
			vision: this.vision,
			builderIds: this.builderIds,
			...this.serializeExtra(),
		};
	}

	protected serializeExtra(): Partial<BuildingSnapshot> {
		return {};
	}

	isComplete() {
		return this.hp >= this.maxHp;
	}

	canTrain(_unitType: UnitType) {
		return false;
	}

	trainableUnits(): readonly UnitType[] {
		return [];
	}

	trainableUnitClasses(): readonly UnitClass[] {
		return [];
	}

	canAcceptResource(_resource: ResourceType) {
		return false;
	}

	depotGatherKind(): ResourceType | null {
		return null;
	}

	soundLevel() {
		return this.isComplete() ? this.sound : this.sound * 0.5;
	}

	canBeGatheredBy(_playerId: string) {
		return false;
	}

	gatherAmountFor(_unit: UnitBehavior) {
		return this.gatherAmount;
	}

	gatherSecondsFor(_unit: UnitBehavior) {
		return this.gatherSeconds;
	}

	onGatheredOut() {}

	maybeReplenish(_spend: (cost: ResourceCost) => boolean, _autoReplenish: boolean) {
		return false;
	}
}
