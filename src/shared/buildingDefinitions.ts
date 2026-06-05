import type { BuildQueueItem, BuildingId, BuildingType, PlayerId, ResourceCost, ResourceType, UnitId, UnitType, Vec2 } from "./types.js";
import { SoldierUnit, VillagerUnit } from "./unitDefinitions.js";
import type { UnitBehavior } from "./unitDefinitions.js";
import type { UnitClass } from "./unitDefinitions.js";

export interface GatherTarget {
  /** Returns how many resources the supplied unit behavior gathers from this target per cycle. */
  gatherAmountFor(unit: UnitBehavior): number;

  /** Returns how long one gather cycle takes for the supplied unit behavior. */
  gatherSecondsFor(unit: UnitBehavior): number;
}

export type BuildingSnapshot = {
  id: BuildingId;
  kind: "building";
  type: BuildingType;
  ownerId: PlayerId;
  x: number;
  y: number;
  size: number;
  hp: number;
  maxHp: number;
  queue: BuildQueueItem[];
  cooldown: number;
  attackFlash: number;
  vision?: number | undefined;
  rallyPoint: Vec2 | null;
  builderIds: UnitId[];
  amount?: number | undefined;
  maxAmount?: number | undefined;
  resource?: ResourceType | undefined;
  exhausted?: boolean | undefined;
};

export type BuildingStats = {
  maxHp: number;
  size: number;
  score: number;
  cost: ResourceCost;
  vision: number;
  sound: number;
};

export type BuildingInit = {
  id: BuildingId;
  ownerId: PlayerId;
  x: number;
  y: number;
  hp?: number;
};

type BuildingState = {
  hp: number;
  maxHp: number;
  size: number;
  vision: number;
};

type BuildingMeta = {
  type: BuildingType;
  label: string;
  sprite: string;
  stats: BuildingStats;
};

export interface BuildingEntity extends BuildingSnapshot, GatherTarget {
  /** Converts this runtime building instance into JSON-safe data for network transfer. */
  serialize(): BuildingSnapshot;

  /** Whether construction has finished and the building can perform completed-building behavior. */
  isComplete(): boolean;

  /** Whether this building is the player's defeat-critical town center. */
  isTownCenter(): boolean;

  /** Whether this building occupies tiles as an obstacle for pathing and placement. */
  isWalkBlocking(): boolean;

  /** Whether this building can train the supplied unit type. */
  canTrain(unitType: UnitType): boolean;

  /** Unit types this building can train, in UI display order. */
  trainableUnits(): readonly UnitType[];

  /** Unit classes this building can train, in UI display order. */
  trainableUnitClasses(): readonly UnitClass[];

  /** Whether this building accepts deposited resources of the supplied type. */
  canAcceptResource(resource: ResourceType): boolean;

  /** Resource type workers should continue gathering after finishing this building, if any. */
  depotGatherKind(): ResourceType | null;

  /** Population capacity contributed by this building when complete. */
  populationCapacity(): number;

  /** Persistent noise this completed building emits for zombie attraction. */
  soundLevel(): number;

  /** Whether the supplied player can gather from this building. */
  canBeGatheredBy(playerId: PlayerId): boolean;

  /** Resource type produced when a unit gathers from this building. */
  gatherResource(): ResourceType | null;

  /** Amount produced by one gather cycle from this building. */
  gatherAmount(): number;

  /** Duration in seconds of one gather cycle from this building. */
  gatherSeconds(): number;

  /** Distance at which a unit can gather from this building. */
  gatherRange(): number;

  /** Whether this building has no currently gatherable resource remaining. */
  isGatherExhausted(): boolean;

  /** Updates building state after a gather cycle drains its available resource. */
  onGatheredOut(): void;

  /** Attempts to replenish gatherable resources, optionally respecting player auto-replenish settings. */
  maybeReplenish(spend: (cost: ResourceCost) => boolean, autoReplenish: boolean): boolean;

  /** Whether workers should immediately gather from this building after completing construction. */
  shouldGatherAfterBuild(): boolean;

  /** Combat stats for buildings that can attack, or null for non-combat buildings. */
  attackStats(): { attack: number; range: number; cooldown: number } | null;
}

export abstract class Building implements BuildingEntity {
  readonly type: BuildingType;
  readonly label: string;
  readonly sprite: string;
  readonly stats: BuildingStats;

  readonly id: BuildingId;
  readonly kind = "building";
  readonly ownerId: PlayerId;
  x: number;
  y: number;
  size: number;
  hp: number;
  maxHp: number;
  queue: BuildQueueItem[];
  cooldown: number;
  attackFlash: number;
  vision?: number;
  rallyPoint: Vec2 | null;
  builderIds: UnitId[];
  amount?: number;
  maxAmount?: number;
  resource?: ResourceType;
  exhausted?: boolean;

  constructor(init: BuildingInit, meta: BuildingMeta) {
    this.type = meta.type;
    this.label = meta.label;
    this.sprite = meta.sprite;
    this.stats = meta.stats;
    const state = this.initialState();
    this.id = init.id;
    this.ownerId = init.ownerId;
    this.x = Math.round(init.x);
    this.y = Math.round(init.y);
    this.size = state.size;
    this.hp = init.hp ?? state.hp;
    this.maxHp = state.maxHp;
    this.queue = [];
    this.cooldown = 0;
    this.attackFlash = 0;
    this.vision = state.vision;
    this.rallyPoint = null;
    this.builderIds = [];
  }

  /** Builds the initial mutable state for a newly constructed building instance. */
  protected initialState(): BuildingState {
    return {
      hp: this.stats.maxHp,
      maxHp: this.stats.maxHp,
      size: this.stats.size,
      vision: this.stats.vision,
    };
  }

  /** Converts this runtime building instance into JSON-safe data for network transfer. */
  serialize(): BuildingSnapshot {
    const snapshot: BuildingSnapshot = {
      id: this.id,
      kind: "building",
      type: this.type,
      ownerId: this.ownerId,
      x: this.x,
      y: this.y,
      size: this.size,
      hp: this.hp,
      maxHp: this.maxHp,
      queue: this.queue,
      cooldown: this.cooldown,
      attackFlash: this.attackFlash,
      vision: this.vision,
      rallyPoint: this.rallyPoint,
      builderIds: this.builderIds,
      amount: this.amount,
      maxAmount: this.maxAmount,
      resource: this.resource,
    };
    if (this.amount !== undefined) snapshot.amount = this.amount;
    if (this.maxAmount !== undefined) snapshot.maxAmount = this.maxAmount;
    if (this.resource !== undefined) snapshot.resource = this.resource;
    if (this.exhausted !== undefined) snapshot.exhausted = this.exhausted;
    return snapshot;
  }

  /** Whether construction has finished and the building can perform completed-building behavior. */
  isComplete() {
    return this.hp >= this.maxHp;
  }

  /** Whether this building is the player's defeat-critical town center. */
  isTownCenter() {
    return false;
  }

  /** Whether this building occupies tiles as an obstacle for pathing and placement. */
  isWalkBlocking() {
    return true;
  }

  /** Whether this building can train the supplied unit type. */
  canTrain(_unitType: UnitType) {
    return false;
  }

  /** Unit types this building can train, in UI display order. */
  trainableUnits(): readonly UnitType[] {
    return [];
  }

  /** Unit classes this building can train, in UI display order. */
  trainableUnitClasses(): readonly UnitClass[] {
    return [];
  }

  /** Whether this building accepts deposited resources of the supplied type. */
  canAcceptResource(_resource: ResourceType) {
    return false;
  }

  /** Resource type workers should continue gathering after finishing this building, if any. */
  depotGatherKind(): ResourceType | null {
    return null;
  }

  /** Population capacity contributed by this building when complete. */
  populationCapacity() {
    return 0;
  }

  soundLevel() {
    return this.isComplete() ? this.stats.sound : this.stats.sound * 0.5;
  }

  /** Whether the supplied player can gather from this building. */
  canBeGatheredBy(_playerId: PlayerId) {
    return false;
  }

  /** Resource type produced when a unit gathers from this building. */
  gatherResource(): ResourceType | null {
    return null;
  }

  /** Amount produced by one gather cycle from this building. */
  gatherAmount() {
    return 0;
  }

  /** Duration in seconds of one gather cycle from this building. */
  gatherSeconds() {
    return 0;
  }

  /** Returns how many resources the supplied unit behavior gathers from this target per cycle. */
  gatherAmountFor(_unit: UnitBehavior) {
    return this.gatherAmount();
  }

  /** Returns how long one gather cycle takes for the supplied unit behavior. */
  gatherSecondsFor(_unit: UnitBehavior) {
    return this.gatherSeconds();
  }

  /** Distance at which a unit can gather from this building. */
  gatherRange() {
    return 1.1;
  }

  /** Whether this building has no currently gatherable resource remaining. */
  isGatherExhausted() {
    return true;
  }

  /** Updates building state after a gather cycle drains its available resource. */
  onGatheredOut() {}

  /** Attempts to replenish gatherable resources, optionally respecting player auto-replenish settings. */
  maybeReplenish(_spend: (cost: ResourceCost) => boolean, _autoReplenish: boolean) {
    return false;
  }

  /** Whether workers should immediately gather from this building after completing construction. */
  shouldGatherAfterBuild() {
    return false;
  }

  /** Combat stats for buildings that can attack, or null for non-combat buildings. */
  attackStats(): { attack: number; range: number; cooldown: number } | null {
    return null;
  }

  /** Applies JSON-safe building data back onto a runtime instance. */
  protected hydrate(snapshot: BuildingSnapshot) {
    this.hp = snapshot.hp;
    this.queue = snapshot.queue;
    this.cooldown = snapshot.cooldown;
    this.attackFlash = snapshot.attackFlash;
    if (snapshot.vision !== undefined) this.vision = snapshot.vision;
    this.rallyPoint = snapshot.rallyPoint;
    this.builderIds = snapshot.builderIds;
    if (snapshot.amount !== undefined) this.amount = snapshot.amount;
    if (snapshot.maxAmount !== undefined) this.maxAmount = snapshot.maxAmount;
    if (snapshot.resource !== undefined) this.resource = snapshot.resource;
    if (snapshot.exhausted !== undefined) this.exhausted = snapshot.exhausted;
  }
}

abstract class ProductionBuilding extends Building {
  abstract readonly trains: readonly UnitClass[];

  /** Whether this building can train the supplied unit type. */
  canTrain(unitType: UnitType) {
    return this.trains.some((Unit) => Unit.type === unitType);
  }

  /** Unit types this building can train, in UI display order. */
  trainableUnits() {
    return this.trains.map((Unit) => Unit.type);
  }

  /** Unit classes this building can train, in UI display order. */
  trainableUnitClasses() {
    return this.trains;
  }
}

abstract class DepotBuilding extends Building {
  abstract readonly accepts: readonly ResourceType[];

  /** Whether this building accepts deposited resources of the supplied type. */
  canAcceptResource(resource: ResourceType) {
    return this.accepts.includes(resource);
  }

  /** Resource type workers should continue gathering after finishing this building, if any. */
  depotGatherKind(): ResourceType | null {
    return this.accepts.length === 1 ? this.accepts[0]! : null;
  }
}

abstract class ProductionDepotBuilding extends DepotBuilding {
  abstract readonly trains: readonly UnitClass[];

  /** Whether this building can train the supplied unit type. */
  canTrain(unitType: UnitType) {
    return this.trains.some((Unit) => Unit.type === unitType);
  }

  /** Unit types this building can train, in UI display order. */
  trainableUnits() {
    return this.trains.map((Unit) => Unit.type);
  }

  /** Unit classes this building can train, in UI display order. */
  trainableUnitClasses() {
    return this.trains;
  }
}

export class TownCenter extends ProductionDepotBuilding {
  constructor(init: BuildingInit) {
    super(init, {
      type: "townCenter",
      label: "Town Center",
      sprite: "townCenter",
      stats: { maxHp: 520, size: 4, score: 120, cost: { wood: 0 }, vision: 8, sound: 10 },
    });
  }

  readonly trains = [VillagerUnit] as const;
  readonly accepts = ["wood", "food", "ore"] as const;

  isTownCenter() {
    return true;
  }
}

export class House extends Building {
  constructor(init: BuildingInit) {
    super(init, {
      type: "house",
      label: "House",
      sprite: "house",
      stats: { maxHp: 140, size: 2, score: 28, cost: { wood: 35 }, vision: 5, sound: 1.5 },
    });
  }

  populationCapacity() {
    return 4;
  }
}

export class Barracks extends ProductionBuilding {
  constructor(init: BuildingInit) {
    super(init, {
      type: "barracks",
      label: "Barracks",
      sprite: "barracks",
      stats: { maxHp: 260, size: 3, score: 70, cost: { wood: 120, ore: 30 }, vision: 6, sound: 5 },
    });
  }

  readonly trains = [SoldierUnit] as const;
}

export class WatchTower extends Building {
  constructor(init: BuildingInit) {
    super(init, {
      type: "watchTower",
      label: "Watch Tower",
      sprite: "watchTower",
      stats: { maxHp: 210, size: 1, score: 55, cost: { wood: 80, ore: 45 }, vision: 11, sound: 3 },
    });
  }

  attackStats() {
    return { attack: 14, range: 5.5, cooldown: 1.4 };
  }
}

export class Farm extends Building {
  readonly replenishCost = { wood: 45 } as const;

  constructor(init: BuildingInit) {
    super(init, {
      type: "farm",
      label: "Farm",
      sprite: "farm",
      stats: { maxHp: 95, size: 4, score: 22, cost: { wood: 45 }, vision: 3, sound: 2 },
    });
    this.amount ??= 160;
    this.maxAmount ??= 160;
    this.resource = "food";
    this.exhausted ??= false;
  }

  isWalkBlocking() {
    return false;
  }

  canBeGatheredBy(playerId: PlayerId) {
    return this.ownerId === playerId && this.isComplete();
  }

  gatherResource() {
    return "food" as const;
  }

  gatherAmount() {
    return 6;
  }

  gatherSeconds() {
    return 8;
  }

  gatherRange() {
    return this.size + 0.7;
  }

  isGatherExhausted() {
    return (this.amount ?? 0) <= 0;
  }

  onGatheredOut() {
    this.exhausted = (this.amount ?? 0) <= 0;
  }

  maybeReplenish(spend: (cost: ResourceCost) => boolean, autoReplenish: boolean) {
    if (!autoReplenish || (this.amount ?? 0) > 0 || !spend(this.replenishCost)) return false;
    this.amount = this.maxAmount || 160;
    this.exhausted = false;
    return true;
  }

  shouldGatherAfterBuild() {
    return true;
  }
}

export class LumberCamp extends DepotBuilding {
  constructor(init: BuildingInit) {
    super(init, {
      type: "lumberCamp",
      label: "Lumber Camp",
      sprite: "lumberCamp",
      stats: { maxHp: 150, size: 1, score: 32, cost: { wood: 70 }, vision: 5, sound: 3 },
    });
  }

  readonly accepts = ["wood"] as const;
}

export class FoodDepot extends DepotBuilding {
  constructor(init: BuildingInit) {
    super(init, {
      type: "foodDepot",
      label: "Food Depot",
      sprite: "foodDepot",
      stats: { maxHp: 150, size: 1, score: 32, cost: { wood: 70 }, vision: 5, sound: 3 },
    });
  }

  readonly accepts = ["food"] as const;
}

export class MiningCamp extends DepotBuilding {
  constructor(init: BuildingInit) {
    super(init, {
      type: "miningCamp",
      label: "Mining Camp",
      sprite: "miningCamp",
      stats: { maxHp: 150, size: 1, score: 32, cost: { wood: 70 }, vision: 5, sound: 3 },
    });
  }

  readonly accepts = ["ore"] as const;
}
