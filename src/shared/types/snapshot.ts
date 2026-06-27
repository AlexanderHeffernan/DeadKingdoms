import type { Corpse, Player, ResourceNode, Ruin, SerializedBuilding, Unit } from "./entities.js";
import type { BuildingId, CorpseId, MapDef, PlayerId, ResourceId, ResourceType, RuinId, UnitId } from "./core.js";
import type { VisibilityPayload } from "./visibility.js";
import type { DayNightState } from "../dayNight.js";

/** Short-lived player-facing notice sent with snapshots. */
export interface Notice {
	id: string;
	text: string;
	at: number;
}

/** Public leaderboard row derived from player state. */
export interface LeaderboardEntry {
	id: PlayerId;
	name: string;
	color: string;
	score: number;
	defeated: boolean;
	joinedAt: number;
	firstPlaceSince: number | null;
}

export interface GlobalLeaderboardEntry {
	id: string;
	playerId: PlayerId;
	playerName: string;
	playerColor: string;
	score: number;
	achievedAt: number;
	snapshotId: string;
	firstPlaceDurationMs: number;
}

export interface LeaderboardPreviewPlayer {
	id: PlayerId;
	name: string;
	color: string;
	defeated: boolean;
	score: number;
}

export type LeaderboardPreviewUnit = Pick<
Unit,
"id" | "kind" | "type" | "ownerId" | "x" | "y" | "size" | "width" | "height" | "facing" | "sprite"
>;

export type LeaderboardPreviewBuilding = Pick<
SerializedBuilding,
"id" | "kind" | "type" | "ownerId" | "x" | "y" | "size" | "width" | "height"
>;

export type LeaderboardPreviewResource = Pick<
ResourceNode,
"id" | "kind" | "type" | "x" | "y" | "size" | "width" | "height" | "resource" | "stage" | "sprite"
>;

export type LeaderboardPreviewRuin = Pick<
Ruin,
"id" | "kind" | "type" | "x" | "y" | "size" | "width" | "height"
>;

export type LeaderboardPreviewCorpse = Pick<
Corpse,
"id" | "kind" | "type" | "originUnitType" | "ownerId" | "x" | "y" | "size" | "zombieSprite"
>;

export interface LeaderboardPreviewSnapshot {
	type: "leaderboardPreview";
	now: number;
	playerId: PlayerId | null;
	map: MapDef;
	players: Record<PlayerId, LeaderboardPreviewPlayer>;
	units: Record<UnitId, LeaderboardPreviewUnit>;
	buildings: Record<BuildingId, LeaderboardPreviewBuilding>;
	resources: Record<ResourceId, LeaderboardPreviewResource>;
	ruins: Record<RuinId, LeaderboardPreviewRuin>;
	corpses: Record<CorpseId, LeaderboardPreviewCorpse>;
}

/** Debug-only sound source sent to clients that enable the sound overlay. */
export interface SoundDebugSource {
	id: string;
	kind: "unit" | "building" | "action" | "field";
	soundKind: "world" | "zombie";
	label: string;
	x: number;
	y: number;
	strength: number;
	range: number;
	cellX?: number;
	cellY?: number;
	cellSize?: number;
	rawStrength?: number;
	sourceCount?: number;
	overflow?: boolean;
	worldStrength?: number;
	zombieStrength?: number;
}

/** Active world sound source sent to clients even when the source unit is not visible. */
export interface HornSoundSource {
	id: string;
	x: number;
	y: number;
	sound: number;
}

/** Backend simulation performance sent with snapshots. */
export interface ServerPerfStats {
	tps: number;
	tickMs: number;
	phases?: ServerPerfPhase[];
	zombies?: ServerPerfZombieStats;
	unitAi?: ServerPerfUnitAiStats[];
	zombieWorker?: ServerPerfZombieWorkerStats;
	zombieAiWorker?: ServerPerfWorkerStats;
}

export type AdminLevel = "admin";

export interface ServerPerfPhase {
	name: string;
	label: string;
	ms: number;
	percent: number;
}

export interface ServerPerfZombieStats {
	total: number;
	stepped: number;
	skipped: number;
	near: number;
	mid: number;
	far: number;
}

export interface ServerPerfUnitAiStats {
	name: string;
	label: string;
	count: number;
	ms: number;
	averageMs: number;
}

export interface ServerPerfZombieWorkerStats {
	enabled: boolean;
	pending: boolean;
	lastDurationMs: number;
	lastCompletedTick: number | null;
	lastAppliedTick: number | null;
	failures: number;
	mode: "worker" | "fallback";
	lastError?: string;
}

export interface ServerPerfWorkerStats {
	enabled: boolean;
	pending: boolean;
	lastDurationMs: number;
	lastCompletedTick: number | null;
	lastAppliedTick: number | null;
	failures: number;
	mode: "worker" | "fallback";
	detail?: ServerPerfWorkerDetail[];
	lastError?: string;
}

export interface ServerPerfWorkerDetail {
	name: string;
	label: string;
	count: number;
	ms: number;
	averageMs: number;
}

export interface ServerPerfSample {
	tick: number;
	tps: number;
	tickMs: number;
	at: number;
	phases?: ServerPerfPhase[];
	zombies?: ServerPerfZombieStats;
	unitAi?: ServerPerfUnitAiStats[];
	zombieWorker?: ServerPerfZombieWorkerStats;
	zombieAiWorker?: ServerPerfWorkerStats;
}

export interface AdminLogEntry {
	id: string;
	at: number;
	source: string;
	message: string;
}

export interface AdminPlayerSnapshot {
	id: PlayerId;
	name: string;
	color: string;
	defeated: boolean;
	score: number;
	population: number;
	popCap: number;
	joinedAt: number;
	connected: boolean;
	lastSeenAt: number | null;
	pingMs: number | null;
	lastSnapshotBytes?: number;
	lastSnapshotKind?: "full" | "delta";
	ipAddress?: string;
}

export type AdminView = "closed" | "popup" | "overview" | "performance" | "performancePaused" | "players" | "logs" | "devCommands" | "bans";

export interface AdminSnapshot {
	level: AdminLevel;
	view: AdminView;
	serverPerf?: ServerPerfStats & {
		samples: ServerPerfSample[];
	};
	players?: AdminPlayerSnapshot[];
	events?: Notice[];
	logs?: AdminLogEntry[];
	bannedIpAddresses?: string[];
}

/** Sanitized player state sent to clients in snapshots. */
export type SnapshotPlayer = Pick<
Player,
"id" | "name" | "color" | "resources" | "autoReplenishFarms" | "population" | "popCap" | "workerCounts" | "defeated" | "score" | "joinedAt"
> & {
	resources: Record<ResourceType, number>;
};

/** Server-to-client world view after visibility filtering. */
export interface Snapshot {
	type: "snapshot";
	seq?: number;
	now: number;
	playerId: PlayerId | null;
	map: MapDef;
	players: Record<PlayerId, SnapshotPlayer>;
	units: Record<UnitId, Unit>;
	buildings: Record<BuildingId, SerializedBuilding>;
	resources: Record<ResourceId, ResourceNode>;
	ruins: Record<RuinId, Ruin>;
	corpses: Record<CorpseId, Corpse>;
	visibility: VisibilityPayload | null;
	dayNight: DayNightState;
	leaderboard: LeaderboardEntry[];
	notices: Notice[];
	hornSounds: HornSoundSource[];
	soundDebug: SoundDebugSource[] | null;
	pathDebug: boolean;
	serverPerf: ServerPerfStats | null;
	admin: AdminSnapshot | null;
}

export interface SnapshotEntityDelta<T> {
	updated: Record<string, T>;
	removed: string[];
}

export interface SnapshotDelta {
	type: "snapshot-delta";
	baseSeq: number;
	seq: number;
	now: number;
	playerId: PlayerId | null;
	players: SnapshotEntityDelta<SnapshotPlayer>;
	units: SnapshotEntityDelta<Unit>;
	buildings: SnapshotEntityDelta<SerializedBuilding>;
	resources: SnapshotEntityDelta<ResourceNode>;
	ruins: SnapshotEntityDelta<Ruin>;
	corpses: SnapshotEntityDelta<Corpse>;
	visibility: VisibilityPayload | null;
	dayNight: DayNightState;
	leaderboard: LeaderboardEntry[];
	notices: Notice[];
	hornSounds: HornSoundSource[];
	soundDebug: SoundDebugSource[] | null;
	pathDebug: boolean;
	serverPerf?: ServerPerfStats | null;
	admin?: AdminSnapshot | null;
}

export type SnapshotMessage = Snapshot | SnapshotDelta;
