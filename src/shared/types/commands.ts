import type {
	BuildingId,
	BuildingType,
	EntityId,
	PlayerId,
	UnitId,
	UnitType,
	Vec2,
} from "./core.js";

/** Player command discriminants accepted by the HTTP command endpoint. */
export type CommandType =
	| "move"
	| "build"
	| "finishBuild"
	| "deleteBuilding"
	| "setRallyPoint"
	| "train"
	| "attack"
	| "gather"
	| "toggleAutoFarm"
	| "replenishFarm";

/** Shared fields for every player-issued command payload. */
export interface CommandBase {
	type: CommandType;
	playerId: PlayerId;
}

export interface MovePayload extends CommandBase, Vec2 {
	type: "move";
	unitIds: UnitId[];
}

export interface BuildPayload extends CommandBase, Vec2 {
	type: "build";
	unitIds: UnitId[];
	buildingType: BuildingType;
}

export interface FinishBuildPayload extends CommandBase {
	type: "finishBuild";
	unitIds: UnitId[];
	buildingId: BuildingId;
}

export interface DeleteBuildingPayload extends CommandBase {
	type: "deleteBuilding";
	buildingId: BuildingId;
}

export interface SetRallyPointPayload extends CommandBase, Vec2 {
	type: "setRallyPoint";
	buildingId: BuildingId;
	targetId?: EntityId | undefined;
}

export interface TrainPayload extends CommandBase {
	type: "train";
	buildingId: BuildingId;
	unitType: UnitType;
}

export interface AttackPayload extends CommandBase {
	type: "attack";
	unitIds: UnitId[];
	targetId: EntityId;
}

export interface GatherPayload extends CommandBase {
	type: "gather";
	unitIds: UnitId[];
	targetId: EntityId;
}

export interface ToggleAutoFarmPayload extends CommandBase {
	type: "toggleAutoFarm";
}

export interface ReplenishFarmPayload extends CommandBase {
	type: "replenishFarm";
	farmId: BuildingId;
}

/** All player-issued commands accepted by the server. */
export type CommandPayload =
| MovePayload
| BuildPayload
| FinishBuildPayload
| DeleteBuildingPayload
| SetRallyPointPayload
| TrainPayload
| AttackPayload
| GatherPayload
| ToggleAutoFarmPayload
| ReplenishFarmPayload;

/** Standard result returned by command handling. */
export type CommandResult = { ok: true; [key: string]: unknown } | { ok: false; error: string };
