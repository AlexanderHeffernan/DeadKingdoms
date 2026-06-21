import type { Building, Corpse, Player, ResourceNode, Ruin, Unit } from "./entities.js";
import type { BuildingId, CorpseId, MapDef, PlayerId, ResourceId, RuinId, UnitId, Vec2 } from "./core.js";
import type { AdminLogEntry, LeaderboardEntry, Notice, ServerPerfSample, ServerPerfStats, ServerPerfUnitAiStats, ServerPerfWorkerStats, ServerPerfZombieStats, ServerPerfZombieWorkerStats } from "./snapshot.js";

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
	targetKind: "sound" | "target" | "drift" | "wander" | null;
	driftDirection: Vec2 | null;
	soundMemory: {
		direction: Vec2;
		target: Vec2;
		significance: number;
		age: number;
	} | null;
}

export interface PathingWorldState {
	occupancyVersion: number;
	flowFields: Map<string, unknown>;
	clearanceFields: Map<number, unknown>;
	arrivalGroups: Map<string, unknown>;
	hardBlockingTiles?: Set<number>;
	hardBlockingTilesVersion?: number;
	blockingBuildingsByTile?: Map<number, Building>;
	blockingBuildingsByTileVersion?: number;
	idleUnitTiles?: Map<number, Map<PlayerId, number>>;
	idleUnitTilesTick?: number;
	movingUnitGrid?: unknown;
	movingUnitGridTick?: number;
	movingZombieGrid?: unknown;
	movingZombieGridTick?: number;
	clearMovementLineCache?: Map<string, boolean>;
	clearMovementLineCacheTick?: number;
	pathRequestsThisTick: number;
	lastRequestTick: number;
}

export interface ZombieCadenceFieldState {
	builtTick: number;
	cellSize: number;
	width: number;
	height: number;
	field: Uint8Array;
	watchedPoints: number;
}

/** Authoritative server-side simulation state for one running arena. */
export interface World {
	map: MapDef;
	players: Record<PlayerId, Player>;
	units: Record<UnitId, Unit>;
	buildings: Record<BuildingId, Building>;
	resources: Record<ResourceId, ResourceNode>;
	ruins: Record<RuinId, Ruin>;
	corpses: Record<CorpseId, Corpse>;
	notices: Notice[];
	adminLogs: AdminLogEntry[];
	actionNoises: ActionNoise[];
	leaderboard: LeaderboardEntry[];
	firstPlacePlayerId?: PlayerId;
	firstPlaceSince?: number;
	startedAt?: number;
	timeOffsetSeconds?: number;
	tick: number;
	spawnTimers: Record<string, number>;
	serverPerf: ServerPerfStats & { lastTickAt?: number; samples: ServerPerfSample[] };
	_zombiePerf?: ServerPerfZombieStats;
	_unitAiPerf?: ServerPerfUnitAiStats[];
	_zombieWorkerPerf?: ServerPerfZombieWorkerStats;
	_zombieAiWorkerPerf?: ServerPerfWorkerStats;
	_occupancy?: Uint8Array;
	_pathing?: PathingWorldState;
	_zombieHordes?: Record<string, ZombieHorde>;
	_zombieCadenceField?: ZombieCadenceFieldState;
}
