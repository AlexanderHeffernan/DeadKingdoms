import type { Building, Player, ResourceNode, Ruin, Unit } from "./entities.js";
import type { BuildingId, MapDef, PlayerId, ResourceId, RuinId, UnitId, Vec2 } from "./core.js";
import type { LeaderboardEntry, Notice } from "./snapshot.js";

export interface ActionNoise extends Vec2 {
  id: string;
  action: string;
  sound: number;
  remaining: number;
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
  _occupancy?: Uint8Array;
}
