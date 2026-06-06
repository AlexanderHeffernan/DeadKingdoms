import type { Player, ResourceNode, Ruin, SerializedBuilding, Unit } from "./entities.js";
import type { BuildingId, MapDef, PlayerId, ResourceId, ResourceType, RuinId, UnitId } from "./core.js";
import type { VisibilityPayload } from "./visibility.js";

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
}

/** Debug-only sound source sent to clients that enable the sound overlay. */
export interface SoundDebugSource {
	id: string;
	kind: "unit" | "building" | "action";
	soundKind: "world" | "zombie";
	label: string;
	x: number;
	y: number;
	strength: number;
	range: number;
}

/** Backend simulation performance sent with snapshots. */
export interface ServerPerfStats {
	tps: number;
	tickMs: number;
}

/** Sanitized player state sent to clients in snapshots. */
export type SnapshotPlayer = Pick<
Player,
"id" | "name" | "color" | "resources" | "autoReplenishFarms" | "population" | "popCap" | "defeated" | "score" | "joinedAt"
> & {
	resources: Record<ResourceType, number>;
};

/** Server-to-client world view after visibility filtering. */
export interface Snapshot {
	type: "snapshot";
	now: number;
	playerId: PlayerId | null;
	map: MapDef;
	players: Record<PlayerId, SnapshotPlayer>;
	units: Record<UnitId, Unit>;
	buildings: Record<BuildingId, SerializedBuilding>;
	resources: Record<ResourceId, ResourceNode>;
	ruins: Record<RuinId, Ruin>;
	visibility: VisibilityPayload | null;
	leaderboard: LeaderboardEntry[];
	notices: Notice[];
	soundDebug: SoundDebugSource[] | null;
	pathDebug: boolean;
	serverPerf: ServerPerfStats;
}
