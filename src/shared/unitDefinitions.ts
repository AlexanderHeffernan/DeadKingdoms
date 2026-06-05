import type { GatherTarget } from "./buildingDefinitions.js";
import type { ResourceCost, UnitType } from "./types.js";

export type UnitStats = {
  maxHp: number;
  speed: number;
  attack: number;
  range: number;
  cooldown: number;
  score: number;
  trainTime: number;
  cost: ResourceCost;
  vision: number;
  sound: number;
};

export type UnitClass<T extends BaseUnit = BaseUnit> = {
  new (): T;
  readonly type: UnitType;
  readonly label: string;
  readonly sprite: string;
  readonly stats: UnitStats;
  readonly trainShortcut?: string | undefined;
};

/**
 * Runtime behavior contract implemented by every trainable unit archetype.
 *
 * When adding a new concrete unit class in this file, also add that class to
 * `UNIT_CLASSES` in `unitRegistry.ts` so serialized unit type names can be
 * resolved back to runtime behavior.
 */
export interface UnitBehavior {
  /** Stable unit type key stored in snapshots, commands, queues, and config. */
  readonly type: string;

  /** Human-readable unit name shown in training and selection UI. */
  readonly label: string;

  /** Sprite registry key used by the renderer and action icons. */
  readonly sprite: string;

  /** Numeric balance values used by simulation, scoring, training, and combat. */
  readonly stats: UnitStats;

  /** Optional keyboard shortcut used by production-building train actions. */
  readonly trainShortcut?: string | undefined;

  /** Whether this unit can receive gather commands and collect resources. */
  canGather(): boolean;

  /** Whether this unit can place and finish player buildings. */
  canBuild(): boolean;

  /** Whether idle simulation should automatically assign nearby enemy targets. */
  canAutoAcquireTargets(): boolean;

  /** Maximum resource amount this unit can carry from non-building resource nodes. */
  carryCapacity(): number;

  /** Persistent noise this unit emits for zombie attraction. */
  soundLevel(): number;

  /** Amount gathered per completed gather cycle for the supplied target. */
  gatherAmount(target: GatherTarget): number;

  /** Duration in seconds of one gather cycle for the supplied target. */
  gatherSeconds(target: GatherTarget): number;
}

export abstract class BaseUnit implements UnitBehavior {
  static readonly type: UnitType;
  static readonly label: string;
  static readonly sprite: string;
  static readonly stats: UnitStats;
  static readonly trainShortcut?: string | undefined;

  get type() {
    return (this.constructor as UnitClass).type;
  }

  get label() {
    return (this.constructor as UnitClass).label;
  }

  get sprite() {
    return (this.constructor as UnitClass).sprite;
  }

  get stats() {
    return (this.constructor as UnitClass).stats;
  }

  get trainShortcut() {
    return (this.constructor as UnitClass).trainShortcut;
  }

  canGather() {
    return false;
  }

  canBuild() {
    return false;
  }

  canAutoAcquireTargets() {
    return false;
  }

  carryCapacity() {
    return 0;
  }

  soundLevel() {
    return this.stats.sound;
  }

  gatherAmount(target: GatherTarget) {
    return target.gatherAmountFor(this);
  }

  gatherSeconds(target: GatherTarget) {
    return target.gatherSecondsFor(this);
  }
}

export class VillagerUnit extends BaseUnit {
  static readonly type = "villager";
  static readonly label = "Villager";
  static readonly sprite = "villager";
  static readonly trainShortcut = "V";
  static readonly stats = {
    maxHp: 40,
    speed: 3.2,
    attack: 3,
    range: 0.9,
    cooldown: 1.1,
    score: 8,
    trainTime: 7,
    cost: { food: 45 },
    vision: 6,
    sound: 1,
  } as const;

  canGather() {
    return true;
  }

  canBuild() {
    return true;
  }

  carryCapacity() {
    return 36;
  }
}

export class SoldierUnit extends BaseUnit {
  static readonly type = "soldier";
  static readonly label = "Soldier";
  static readonly sprite = "soldier";
  static readonly trainShortcut = "S";
  static readonly stats = {
    maxHp: 70,
    speed: 4.1,
    attack: 9,
    range: 1.05,
    cooldown: 0.8,
    score: 18,
    trainTime: 8,
    cost: { food: 45, ore: 20 },
    vision: 7,
    sound: 1.8,
  } as const;

  canAutoAcquireTargets() {
    return true;
  }
}

export class ZombieUnit extends BaseUnit {
  static readonly type = "zombie";
  static readonly label = "Zombie";
  static readonly sprite = "zombie";
  static readonly stats = {
    maxHp: 34,
    speed: 1.35,
    attack: 5,
    range: 0.55,
    cooldown: 1.5,
    score: 0,
    trainTime: 0,
    cost: {},
    vision: 0,
    sound: 0.35,
  } as const;
}
