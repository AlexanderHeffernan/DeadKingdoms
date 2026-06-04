import type { Building, Player, ResourceNode, Ruin, Unit } from "./entities.js";
import type { BuildingId, MapDef, PlayerId, ResourceId, RuinId, UnitId } from "./core.js";
import type { LeaderboardEntry, Notice } from "./snapshot.js";

/** Authoritative server-side simulation state for one running arena. */
export interface World {
  map: MapDef;
  players: Record<PlayerId, Player>;
  units: Record<UnitId, Unit>;
  buildings: Record<BuildingId, Building>;
  resources: Record<ResourceId, ResourceNode>;
  ruins: Record<RuinId, Ruin>;
  notices: Notice[];
  leaderboard: LeaderboardEntry[];
  tick: number;
  _occupancy?: Uint8Array;
}
