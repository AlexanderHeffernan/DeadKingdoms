import type {
  BUILDING_DEFS,
  RESOURCE_DEFS,
  RESOURCE_TYPES,
  UNIT_DEFS,
} from "../config.js";

/** Resource identifiers used by player inventories, costs, and gatherable nodes. */
export type ResourceType = (typeof RESOURCE_TYPES)[number];

/** Unit archetype names from the shared unit definition table. */
export type UnitType = keyof typeof UNIT_DEFS;

/** Building archetype names from the shared building definition table. */
export type BuildingType = keyof typeof BUILDING_DEFS;

/** Natural resource node archetype names from the shared resource definition table. */
export type ResourceNodeType = keyof typeof RESOURCE_DEFS;

/** Sprite keys that can be requested by renderer and UI code. */
export type SpriteName =
  | UnitType
  | BuildingType
  | "tree"
  | "ore"
  | "berry"
  | "stump"
  | "ruin";

/** Stable player identifier used across commands, snapshots, and world state. */
export type PlayerId = string;

/** Stable unit identifier used across commands, snapshots, and world state. */
export type UnitId = string;

/** Stable building identifier used across commands, snapshots, and world state. */
export type BuildingId = string;

/** Stable resource node identifier used across snapshots and world state. */
export type ResourceId = string;

/** Stable ruin identifier used across snapshots and world state. */
export type RuinId = string;

/** Any entity identifier that can be targeted or selected. */
export type EntityId = UnitId | BuildingId | ResourceId | RuinId;

/** Horizontal facing used by mobile combat and worker sprites. */
export type Facing = "left" | "right";

/** Two-dimensional world-space coordinate. */
export interface Vec2 {
  x: number;
  y: number;
}

/** Basic map metadata shared with clients. */
export interface MapDef {
  size: number;
}

/** Partial resource-price map used by buildings, units, and replenishment. */
export type ResourceCost = Partial<Record<ResourceType, number>>;

/** Pathfinding node used by movement commands and A* bookkeeping. */
export interface PathNode extends Vec2 {
  g?: number;
  f?: number;
  parent?: PathNode | null;
}
