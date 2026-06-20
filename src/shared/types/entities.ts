import type {
	BuildingId,
	BuildingType,
	EntityId,
	Facing,
	PlayerId,
	PathNode,
	ResourceId,
	ResourceNodeType,
	ResourceType,
	RuinId,
	CorpseId,
	UnitId,
	UnitType,
	Vec2,
} from "./core.js";
import type { UnitCommand } from "./unitCommands.js";
import type { VisibilityCache } from "./visibility.js";
import type { BuildingEntity, BuildingSnapshot } from "../buildings/base/index.js";
import type { AdminLevel } from "./snapshot.js";

export type ZombieDebugState =
	| "sound"
	| "pathing"
	| "stuck"
	| "wander"
	| "aggro"
	| "idle"
	| "blocked";

export interface PlayerConnection {
	ipAddress: string | null;
	connectedAt: number;
	lastSeenAt: number;
	streamCount: number;
	pingMs?: number;
}

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
	adminLevel?: AdminLevel;
	soundDebug?: boolean;
	pathDebug?: boolean;
	zombieDebug?: boolean;
	connection?: PlayerConnection;
	_visCache?: VisibilityCache;
}

/** Common position and identity fields for every world entity. */
export interface BaseEntity extends Vec2 {
	id: EntityId;
	kind: "unit" | "building" | "resource" | "ruin" | "corpse";
	type: string;
	ownerId?: PlayerId;
	size?: number;
	width?: number;
	height?: number;
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
	hordeTarget?: Vec2 | null;
	zombieGoalKind?: "sound" | "target" | "drift" | "wander" | null;
	zombieDebugState?: ZombieDebugState;
	zombieHordeColor?: string;
	zombiePath?: PathNode[] | null;
	zombiePathTarget?: Vec2 | null;
	zombieStuckTicks?: number;
	retargetIn?: number;
	hordeId?: string | null;
	zombieDriftDirection?: Vec2 | null;
	zombieHordeSourceTarget?: Vec2 | null;
	sprite?: "zombie_def" | "zombie_vil" | "zombie_sol";
}

export interface Corpse extends BaseEntity {
	id: CorpseId;
	kind: "corpse";
	type: "corpse";
	originUnitType: Exclude<UnitType, "zombie">;
	x: number;
	y: number;
	size: 1;
	hp: number;
	maxHp: number;
	ownerId: PlayerId;
	remaining: number;
	zombieSprite: "zombie_vil" | "zombie_sol";
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
	width?: number;
	height?: number;
	age: number;
}
