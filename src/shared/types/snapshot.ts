import type { Building, Player, ResourceNode, Ruin, Unit } from "./entities.js";
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
  buildings: Record<BuildingId, Building>;
  resources: Record<ResourceId, ResourceNode>;
  ruins: Record<RuinId, Ruin>;
  visibility: VisibilityPayload | null;
  leaderboard: LeaderboardEntry[];
  notices: Notice[];
}
