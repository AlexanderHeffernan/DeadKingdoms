import type { ResourceCost } from "./types.js";

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
};

/** Runtime behavior contract implemented by every trainable unit archetype. */
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
  readonly trainShortcut?: string;

  /** Whether this unit can receive gather commands and collect resources. */
  canGather(): boolean;

  /** Whether this unit can place and finish player buildings. */
  canBuild(): boolean;

  /** Whether idle simulation should automatically assign nearby enemy targets. */
  canAutoAcquireTargets(): boolean;

  /** Maximum resource amount this unit can carry from non-building resource nodes. */
  carryCapacity(): number;

  /** Amount gathered per completed gather cycle for the supplied target kind. */
  gatherAmount(target: { kind: string; type: string }): number;

  /** Duration in seconds of one gather cycle for the supplied target kind. */
  gatherSeconds(target: { kind: string; type: string }): number;
}

export abstract class BaseUnit implements UnitBehavior {
  abstract readonly type: string;
  abstract readonly label: string;
  abstract readonly sprite: string;
  abstract readonly stats: UnitStats;
  readonly trainShortcut?: string;

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

  gatherAmount(target: { kind: string; type: string }) {
    if (target.kind === "building" && target.type === "farm") return 6;
    return this.carryCapacity();
  }

  gatherSeconds(target: { kind: string; type: string }) {
    if (target.kind === "building" && target.type === "farm") return 8;
    return 1.1;
  }
}

export class VillagerUnit extends BaseUnit {
  readonly type = "villager";
  readonly label = "Villager";
  readonly sprite = "villager";
  readonly trainShortcut = "V";
  readonly stats = {
    maxHp: 40,
    speed: 3.2,
    attack: 3,
    range: 0.9,
    cooldown: 1.1,
    score: 8,
    trainTime: 7,
    cost: { food: 45 },
    vision: 6,
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
  readonly type = "soldier";
  readonly label = "Soldier";
  readonly sprite = "soldier";
  readonly trainShortcut = "S";
  readonly stats = {
    maxHp: 70,
    speed: 4.1,
    attack: 9,
    range: 1.05,
    cooldown: 0.8,
    score: 18,
    trainTime: 8,
    cost: { food: 45, ore: 20 },
    vision: 7,
  } as const;

  canAutoAcquireTargets() {
    return true;
  }
}

export function defineUnits<const T extends readonly UnitBehavior[]>(units: T) {
  return Object.fromEntries(units.map((unit) => [unit.type, unit])) as {
    [K in T[number]["type"]]: Extract<T[number], { type: K }>;
  };
}
