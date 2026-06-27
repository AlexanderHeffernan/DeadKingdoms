import type { BuildingId, EntityId, PathNode, ResourceType, Vec2 } from "./core.js";

/** Command currently assigned to a simulated unit. */
export interface UnitCommandBase {
	type: UnitCommandType;
	path?: PathNode[] | null;
	pathCrowd?: number;
	formationTarget?: Vec2;
	moveGroupId?: string;
	moveGroupTarget?: Vec2;
	moveStuckTicks?: number;
	moveBestDistance?: number;
	interactionTargetKey?: string;
	interactionBestCost?: number;
	/** World tick of the last executed path search; used to throttle replans when no usable path exists. */
	pathRetryTick?: number;
}

/** Unit command discriminants understood by the world simulation. */
export type UnitCommandType = "idle" | "move" | "attack" | "gather" | "build";

export interface MoveCommand extends UnitCommandBase, Vec2 {
	type: "move";
}

export interface AttackCommand extends UnitCommandBase {
	type: "attack";
	targetId: EntityId;
}

export interface GatherCommand extends UnitCommandBase {
	type: "gather";
	targetId: EntityId;
	resourceKind: ResourceType;
	progress?: number;
}

export interface BuildCommand extends UnitCommandBase {
	type: "build";
	targetId: BuildingId;
	resourceKind: ResourceType | null;
	gatherBuiltFarm?: boolean;
}

export interface IdleCommand extends UnitCommandBase {
	type: "idle";
}

/** All unit command shapes stored on units in world state. */
export type UnitCommand = MoveCommand | AttackCommand | GatherCommand | BuildCommand | IdleCommand;
