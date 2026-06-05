import type {
	BuildingId,
	BuildingType,
	EntityId,
	Facing,
	PlayerId,
	ResourceId,
	ResourceNodeType,
	ResourceType,
	RuinId,
	UnitId,
	UnitType,
	Vec2,
} from "./core.js";
import type { UnitCommand } from "./unitCommands.js";
import type { VisibilityCache } from "./visibility.js";
import type { BuildingEntity, BuildingSnapshot } from "../buildingDefinitions.js";

/** Player-owned economy, score, fog-of-war, and population state. */
export interface Player {
	id: PlayerId;
	name: string;
	color: string;
	resources: Record<ResourceType, number>;
	autoReplenishFarms: boolean;
	explored: Set<number>;
	population: number;
	popCap: number;
	defeated: boolean;
	score: number;
	joinedAt: number;
	godMode?: boolean;
	soundDebug?: boolean;
	_visCache?: VisibilityCache;
}

/** Common position and identity fields for every world entity. */
export interface BaseEntity extends Vec2 {
	id: EntityId;
	kind: "unit" | "building" | "resource" | "ruin";
	type: string;
	ownerId?: PlayerId;
	size?: number;
}

/** Simulated mobile unit with command, combat, worker, and render state. */
export interface Unit extends BaseEntity {
	id: UnitId;
	kind: "unit";
	type: UnitType;
	ownerId: PlayerId;
	hp: number;
	maxHp: number;
	command: UnitCommand;
	cooldown: number;
	attackFlash: number;
	workFlash: number;
	facing: Facing;
	carried: null | { resource: ResourceType; amount: number };
	selected: boolean;
	vision?: number;
	soundTarget?: Vec2 | null;
	wanderTarget?: Vec2 | null;
	investigateTarget?: Vec2 | null;
	investigateTime?: number;
	retargetIn?: number;
}

/** Pending unit-production entry for train-capable buildings. */
export interface BuildQueueItem {
	unitType: UnitType;
	remaining: number;
}

/** Simulated player structure, including production, combat, storage, and farm state. */
export type Building = BuildingEntity;

/** JSON-safe building payload used only at network boundaries. */
export type SerializedBuilding = BuildingSnapshot;

/** Gatherable world resource or depleted stump. */
export interface ResourceNode extends BaseEntity {
	id: ResourceId;
	kind: "resource";
	type: ResourceNodeType | "stump";
	resource: ResourceType;
	amount: number;
	maxAmount: number;
	stage?: "tree" | "stump" | "ore" | "berry";
	decay?: number;
	sprite?: "stump";
}

/** Temporary remains of a destroyed building. */
export interface Ruin extends BaseEntity {
	id: RuinId;
	kind: "ruin";
	type: BuildingType;
	size: number;
	age: number;
}
