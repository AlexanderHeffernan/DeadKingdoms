import type { Building, Player, ResourceNode, Ruin, Unit } from "./entities.js";
import type { BuildingId, MapDef, PlayerId, ResourceId, RuinId, UnitId, Vec2 } from "./core.js";
import type { LeaderboardEntry, Notice, ServerPerfStats } from "./snapshot.js";

export interface ActionNoise extends Vec2 {
	id: string;
	action: string;
	sound: number;
	remaining: number;
}

export interface ZombieHorde {
	id: string;
	memberIds: UnitId[];
	center: Vec2;
	radius: number;
	target: Vec2 | null;
	targetMemory: number;
	wanderTarget: Vec2 | null;
}

export interface PathingWorldState {
	occupancyVersion: number;
	flowFields: Map<string, unknown>;
	clearanceFields: Map<number, unknown>;
	arrivalGroups: Map<string, unknown>;
	pathRequestsThisTick: number;
	lastRequestTick: number;
}

/** Authoritative server-side simulation state for one running arena. */
export interface World {
	map: MapDef;
	players: Record<PlayerId, Player>;
	units: Record<UnitId, Unit>;
	buildings: Record<BuildingId, Building>;
	resources: Record<ResourceId, ResourceNode>;
	ruins: Record<RuinId, Ruin>;
	notices: Notice[];
	actionNoises: ActionNoise[];
	leaderboard: LeaderboardEntry[];
	tick: number;
	spawnTimers: Record<string, number>;
	serverPerf: ServerPerfStats & { lastTickAt?: number };
	_occupancy?: Uint8Array;
	_pathing?: PathingWorldState;
	_zombieHordes?: Record<string, ZombieHorde>;
}
