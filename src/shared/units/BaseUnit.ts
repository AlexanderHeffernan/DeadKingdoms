import type { GatherTarget } from "../buildings/base/index.js";
import type { Building, ResourceCost, ResourceNode, Unit, UnitCommand, UnitType, World } from "../types.js";

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
	readonly maxHp: number;
	readonly speed: number;
	readonly attack: number;
	readonly range: number;
	readonly cooldown: number;
	readonly score: number;
	readonly trainTime: number;
	readonly cost: ResourceCost;
	readonly vision: number;
	readonly sound: number;
	readonly canGather: boolean;
	readonly canBuild: boolean;
	readonly canAutoAcquireTargets: boolean;
	readonly carryCapacity: number;
	readonly trainShortcut?: string | undefined;
};

export type UnitCombatTarget = Unit | Building;

export type UnitSimulationContext = {
	readonly world: World;

	/** Moves a unit along a stored move-command path, recalculating path state as needed. */
	moveWithPath(unit: Unit, command: Extract<UnitCommand, { type: "move" }>, maxStep: number): boolean;

	/** Moves a unit toward interaction range of a target point using pathing. */
	moveNearTarget(unit: Unit, command: UnitCommand, target: { x: number; y: number }, range: number, maxStep: number): boolean;

	/** Moves a unit directly toward a target point and reports whether movement was blocked or arrived. */
	moveUnit(unit: Unit, target: { x: number; y: number }, maxStep: number): boolean;

	/** Moves a zombie with normal pathing capped to a short local lookahead. */
	moveZombieWithPath(unit: Unit, target: { x: number; y: number }, maxStep: number): boolean;

	/** Moves a zombie with cheap local steering around obstacles and crowding. */
	moveZombieSteered(unit: Unit, target: { x: number; y: number }, maxStep: number): boolean;

	/** Moves directly, with a tiny local sidestep only around isolated obstacles. */
	moveAroundSmallObstacle(unit: Unit, target: { x: number; y: number }, maxStep: number): boolean;

	/** Returns the center point of an entity-like object. */
	centerOf(entity: { x: number; y: number; size?: number }): { x: number; y: number };

	/** Returns Euclidean distance between two points. */
	distance(a: { x: number; y: number }, b: { x: number; y: number }): number;

	/** Looks up an attackable unit or building by id. */
	targetById(targetId: string): UnitCombatTarget | null;

	/** Looks up a building by id. */
	buildingById(buildingId: string): Building | null;

	/** Whether the supplied building has completed construction. */
	isComplete(building: Building): boolean;

	/** Persistent noise emitted by the supplied unit. */
	unitSoundLevel(unit: Unit): number;

	/** Finds the nearest enemy entity within the supplied range. */
	nearestEnemy(source: Unit | Building, range: number): UnitCombatTarget | null;

	/** Finds living non-zombie units near the supplied point. */
	nearbyTargetUnits(source: { x: number; y: number }, range: number): Unit[];

	/** Applies damage to a unit or building and performs any death side effects. */
	damage(target: UnitCombatTarget, amount: number, attackerId: Unit["ownerId"]): void;

	/** Emits a temporary action sound for zombie attraction. */
	emitActionSound(action: "unitAttack" | "build" | "chopWood" | "mineOre" | "gatherFood", point: { x: number; y: number }): void;

	/** Resolves a gather command target id to a resource node or gatherable building. */
	gatherTarget(targetId: string, playerId: Unit["ownerId"]): ResourceNode | Building | null;

	/** Returns the resource type yielded by a resource node or gatherable building. */
	gatherResource(entity: ResourceNode | Building): "wood" | "food" | "ore";

	/** Adapts a resource node or building into the gather target interface. */
	gatherTargetFor(entity: ResourceNode | Building): GatherTarget;

	/** Returns how close a unit must be to gather from the target. */
	gatherRange(entity: ResourceNode | Building): number;

	/** Whether an entity is a building instance. */
	isBuilding(entity: ResourceNode | Building | null | undefined): entity is Building;

	/** Finds the nearest completed depot that accepts the supplied resource. */
	nearestDepot(ownerId: Unit["ownerId"], resource: "wood" | "food" | "ore", source: { x: number; y: number }): Building | null;

	/** Finds the next nearby resource or gatherable building for continued gathering. */
	findNextResource(unit: Unit, resourceKind: "wood" | "food" | "ore" | null): ResourceNode | Building | null;

	/** Attempts automatic replenishment for a gatherable building. */
	maybeAutoReplenishBuilding(building: Building): void;

	/** Removes a resource node from the world. */
	deleteResource(resource: ResourceNode): void;

	/** Converts a depleted tree resource into a stump. */
	makeStump(resource: ResourceNode): void;

	/** Deposits carried resources into the owning player's stockpile. */
	depositResource(ownerId: Unit["ownerId"], resource: "wood" | "food" | "ore", amount: number): void;

	/** Finds the next incomplete building site this unit should help construct. */
	findNextBuildSite(unit: Unit): Building | null;

	/** Assigns the unit's post-construction gather or build follow-up command. */
	assignPostBuildGather(unit: Unit, resourceKind: "wood" | "food" | "ore" | null, builtFarm?: Building | null): void;

	/** Lets a blocked melee unit damage the building obstructing its path. */
	attackBlockingBuilding(unit: Unit, targetPoint: { x: number; y: number }): void;

	/** Whether this unit can find a walkable route into interaction range of the target point. */
	hasPathToTarget(unit: Unit, targetPoint: { x: number; y: number }, range: number): boolean;

	/** Finds the first enemy building obstructing a unit's route toward a target point. */
	blockingBuildingToward(unit: Unit, targetPoint: { x: number; y: number }): Building | null;
};

/**
 * Runtime behavior contract implemented by every unit archetype.
 *
 * Concrete units own their command/AI behavior here while the world keeps
 * storing JSON-safe mutable unit state for snapshots and networking.
 */
export interface UnitBehavior {
	/** Stable unit type key stored in snapshots, commands, queues, and config. */
	readonly type: string;

	/** Human-readable unit name shown in training and selection UI. */
	readonly label: string;

	/** Sprite registry key used by the renderer and action icons. */
	readonly sprite: string;

	/** Numeric balance values used by simulation, scoring, training, and combat. */
	readonly maxHp: number;
	readonly speed: number;
	readonly attack: number;
	readonly range: number;
	readonly cooldown: number;
	readonly score: number;
	readonly trainTime: number;
	readonly cost: ResourceCost;
	readonly vision: number;
	readonly sound: number;

	/** Optional keyboard shortcut used by production-building train actions. */
	readonly trainShortcut?: string | undefined;

	/** Advances this unit's simulation for one world tick. */
	step(context: UnitSimulationContext, unit: Unit, dt: number): void;

	readonly canGather: boolean;
	readonly canBuild: boolean;
	readonly canAutoAcquireTargets: boolean;
	readonly carryCapacity: number;

	/** Persistent noise this unit emits for zombie attraction. */
	soundLevel(): number;

	/** Amount gathered per completed gather cycle for the supplied target. */
	gatherAmount(target: GatherTarget): number;

	/** Duration in seconds of one gather cycle for the supplied target. */
	gatherSeconds(target: GatherTarget): number;
}

export abstract class BaseUnit implements UnitBehavior {
	public static readonly type: UnitType;
	public static readonly label: string;
	public static readonly sprite: string;
	public static readonly maxHp: number;
	public static readonly speed: number;
	public static readonly attack: number;
	public static readonly range: number;
	public static readonly cooldown: number;
	public static readonly score: number;
	public static readonly trainTime: number;
	public static readonly cost: ResourceCost;
	public static readonly vision: number;
	public static readonly sound: number;
	public static readonly canGather: boolean = false;
	public static readonly canBuild: boolean = false;
	public static readonly canAutoAcquireTargets: boolean = false;
	public static readonly carryCapacity: number = 0;
	public static readonly trainShortcut?: string | undefined;

	/** Stable unit type key stored in snapshots, commands, queues, and config. */
	public get type() {
		return (this.constructor as UnitClass).type;
	}

	/** Human-readable unit name shown in training and selection UI. */
	public get label() {
		return (this.constructor as UnitClass).label;
	}

	/** Sprite registry key used by the renderer and action icons. */
	public get sprite() {
		return (this.constructor as UnitClass).sprite;
	}

	public get maxHp() { return (this.constructor as UnitClass).maxHp; }
	public get speed() { return (this.constructor as UnitClass).speed; }
	public get attack() { return (this.constructor as UnitClass).attack; }
	public get range() { return (this.constructor as UnitClass).range; }
	public get cooldown() { return (this.constructor as UnitClass).cooldown; }
	public get score() { return (this.constructor as UnitClass).score; }
	public get trainTime() { return (this.constructor as UnitClass).trainTime; }
	public get cost() { return (this.constructor as UnitClass).cost; }
	public get vision() { return (this.constructor as UnitClass).vision; }
	public get sound() { return (this.constructor as UnitClass).sound; }
	public get canGather() { return (this.constructor as UnitClass).canGather; }
	public get canBuild() { return (this.constructor as UnitClass).canBuild; }
	public get canAutoAcquireTargets() { return (this.constructor as UnitClass).canAutoAcquireTargets; }
	public get carryCapacity() { return (this.constructor as UnitClass).carryCapacity; }

	/** Optional keyboard shortcut used by production-building train actions. */
	public get trainShortcut() {
		return (this.constructor as UnitClass).trainShortcut;
	}

	/** Advances this unit's simulation for one world tick. */
	public step(context: UnitSimulationContext, unit: Unit, dt: number) {
		this.updateTimers(unit, dt);
		unit.vision = this.vision || 5;
		const command = unit.command || { type: "idle" };
		if (command.type === "idle") this.stepIdle(context, unit);
			else if (command.type === "move") this.stepMove(context, unit, command, dt);
				else if (command.type === "attack") this.stepAttack(context, unit, command, dt);
					else unit.command = { type: "idle" };
	}

	protected updateTimers(unit: Unit, dt: number) {
		unit.cooldown = Math.max(0, unit.cooldown - dt);
		unit.attackFlash = Math.max(0, (unit.attackFlash || 0) - dt);
		unit.workFlash = Math.max(0, (unit.workFlash || 0) - dt);
	}

	protected stepIdle(context: UnitSimulationContext, unit: Unit) {
		if (!this.canAutoAcquireTargets) return;
		const target = context.nearestEnemy(unit, 5.5);
		if (target) unit.command = { type: "attack", targetId: target.id };
	}

	protected stepMove(context: UnitSimulationContext, unit: Unit, command: Extract<UnitCommand, { type: "move" }>, dt: number) {
		unit.facing = command.x < unit.x ? "left" : "right";
		if (context.moveWithPath(unit, command, this.speed * dt)) unit.command = { type: "idle" };
	}

	protected stepAttack(context: UnitSimulationContext, unit: Unit, command: Extract<UnitCommand, { type: "attack" }>, dt: number) {
		const target = context.targetById(command.targetId);
		const explicitTarget = target && target.ownerId !== unit.ownerId ? target : null;
		if (!explicitTarget) {
			const nextTarget = context.nearestEnemy(unit, 5.5);
			unit.command = nextTarget ? { type: "attack", targetId: nextTarget.id } : { type: "idle" };
			return;
		}
		const targetPoint = context.centerOf(explicitTarget);
		const range = this.range + (explicitTarget.size || 0.6);
		if (context.distance(unit, targetPoint) > range) {
			unit.facing = targetPoint.x < unit.x ? "left" : "right";
			context.moveNearTarget(unit, command, targetPoint, range, this.speed * dt);
			return;
		}
		if (unit.cooldown <= 0) {
			context.damage(explicitTarget, this.attack, unit.ownerId);
			context.emitActionSound("unitAttack", unit);
			unit.cooldown = this.cooldown;
			unit.attackFlash = 0.22;
			const nextTarget = context.nearestEnemy(unit, 5.5);
			if (nextTarget && !context.targetById(command.targetId)) {
				unit.command = { type: "attack", targetId: nextTarget.id };
			}
		}
	}

	/** Persistent noise this unit emits for zombie attraction. */
	public soundLevel() {
		return this.sound;
	}

	/** Amount gathered per completed gather cycle for the supplied target. */
	public gatherAmount(target: GatherTarget) {
		return target.gatherAmountFor(this);
	}

	/** Duration in seconds of one gather cycle for the supplied target. */
	public gatherSeconds(target: GatherTarget) {
		return target.gatherSecondsFor(this);
	}
}
