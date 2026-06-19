import type { BuildQueueItem, BuildingId, BuildingType, PlayerId, ResourceCost, ResourceType, UnitId, UnitType, Vec2 } from "../../types.js";
import type { UnitBehavior, UnitClass } from "../../units/index.js";

export interface GatherTarget {
	gatherAmountFor(unit: UnitBehavior): number;
	gatherSecondsFor(unit: UnitBehavior): number;
}

export type BuildingSnapshot = {
	id: BuildingId;
	kind: "building";
	type: BuildingType;
	ownerId: PlayerId;
	x: number;
	y: number;
	size: number;
	width: number;
	height: number;
	hp: number;
	maxHp: number;
	completed: boolean;
	repairPaidUntilHp: number | undefined;
	vision?: number | undefined;
	builderIds: UnitId[];
	queue?: BuildQueueItem[] | undefined;
	rallyPoint?: Vec2 | null | undefined;
	rallyTargetId?: string | null | undefined;
	cooldown?: number | undefined;
	attackFlash?: number | undefined;
	amount?: number | undefined;
	maxAmount?: number | undefined;
	resource?: ResourceType | undefined;
	exhausted?: boolean | undefined;
};

export type BuildingInit = {
	id: BuildingId;
	ownerId: PlayerId;
	x: number;
	y: number;
	hp?: number;
	completed?: boolean;
	repairPaidUntilHp?: number | undefined;
};

export type BuildingClass = {
	readonly type: BuildingType;
	readonly label: string;
	readonly sprite: string;
	readonly maxHp: number;
	readonly size: number;
	readonly width?: number;
	readonly height?: number;
	readonly score: number;
	readonly cost: ResourceCost;
	readonly vision: number;
	readonly sound: number;
	readonly walkBlocking?: boolean;
	readonly populationCapacity?: number;
	readonly gatherResource?: ResourceType | null;
	readonly gatherAmount?: number;
	readonly gatherSeconds?: number;
	readonly gatherRange?: number;
	readonly shouldGatherAfterBuild?: boolean;
};

export type BuildingConstructor = (new (init: BuildingInit) => BuildingEntity) & BuildingClass;

export interface BuildingEntity extends GatherTarget {
	readonly id: BuildingId;
	readonly kind: "building";
	readonly ownerId: PlayerId;
	x: number;
	y: number;
	hp: number;
	completed: boolean;
	repairPaidUntilHp: number | undefined;
	readonly type: BuildingType;
	readonly label: string;
	readonly sprite: string;
	readonly maxHp: number;
	readonly size: number;
	readonly width: number;
	readonly height: number;
	readonly score: number;
	readonly cost: ResourceCost;
	readonly vision: number;
	readonly sound: number;
	readonly walkBlocking: boolean;
	readonly populationCapacity: number;
	readonly gatherResource: ResourceType | null;
	readonly gatherAmount: number;
	readonly gatherSeconds: number;
	readonly gatherRange: number;
	readonly gatherExhausted: boolean;
	readonly shouldGatherAfterBuild: boolean;
	readonly canAttack: boolean;
	readonly attack: number;
	readonly attackRange: number;
	readonly attackCooldown: number;
	builderIds: UnitId[];
	queue?: BuildQueueItem[] | undefined;
	rallyPoint?: Vec2 | null | undefined;
	rallyTargetId?: string | null | undefined;
	cooldown?: number | undefined;
	attackFlash?: number | undefined;
	amount?: number | undefined;
	maxAmount?: number | undefined;
	resource?: ResourceType | undefined;
	exhausted?: boolean | undefined;
	invincible?: boolean;
	serialize(): BuildingSnapshot;
	isComplete(): boolean;
	markComplete(): void;
	startConstruction(hp: number): void;
	canTrain(unitType: UnitType): boolean;
	trainableUnits(): readonly UnitType[];
	trainableUnitClasses(): readonly UnitClass[];
	canAcceptResource(resource: ResourceType): boolean;
	depotGatherKind(): ResourceType | null;
	soundLevel(): number;
	canBeGatheredBy(playerId: PlayerId): boolean;
	onGatheredOut(): void;
	maybeReplenish(spend: (cost: ResourceCost) => boolean, autoReplenish: boolean): boolean;
}
