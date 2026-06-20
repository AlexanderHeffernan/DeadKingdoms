import { BaseUnit } from "./BaseUnit.js";
import type { UnitCombatTarget, UnitSimulationContext } from "./BaseUnit.js";
import type { Unit, Vec2 } from "../types.js";

const ZOMBIE_TARGET_SIGHT_RANGE = 21;
const ZOMBIE_PATH_STUCK_TICKS = 10;
const ZOMBIE_PROGRESS_EPSILON = 0.03;
const ZOMBIE_SIDEWAYS_PROGRESS_TOLERANCE = 0.015;

export class ZombieUnit extends BaseUnit {
	public static readonly type = "zombie";
	public static readonly label = "Zombie";
	public static readonly sprite = "zombie_def";
	public static readonly maxHp = 10;
	public static readonly speed = 1;
	public static readonly attack = 2;
	public static readonly range = 0.55;
	public static readonly cooldown = 2;
	public static readonly score = 0;
	public static readonly trainTime = 0;
	public static readonly cost = {};
	public static readonly vision = 0;
	public static readonly sound = 0;

	public step(context: UnitSimulationContext, zombie: Unit, dt: number) {
		this.updateTimers(zombie, dt);

		// Check for nearby units before following horde movement.
		const target = this.findNearestUnitTarget(context, zombie, ZOMBIE_TARGET_SIGHT_RANGE);
		if (target) {
			this.engageTarget(context, zombie, this.targetOrBlockingBuilding(context, zombie, target), dt);
			return;
		}

		if (this.shouldPrioritizeHordeTarget(zombie)) {
			this.followHordeTarget(context, zombie, zombie.hordeTarget, dt);
			return;
		}

		const buildingTarget = this.findNearestBuildingTarget(context, zombie, ZOMBIE_TARGET_SIGHT_RANGE);
		if (buildingTarget) {
			this.engageTarget(context, zombie, buildingTarget, dt);
			return;
		}

		if (zombie.hordeTarget) {
			this.followHordeTarget(context, zombie, zombie.hordeTarget, dt);
			return;
		}

		// Else, walk in last direction
		if (zombie.zombieDriftDirection) {
			this.driftForward(context, zombie, dt);
			return;
		}

		this.clearMovementState(zombie);
	}

	private shouldPrioritizeHordeTarget(zombie: Unit): zombie is Unit & { hordeTarget: Vec2 } {
		return !!zombie.hordeTarget && zombie.zombieGoalKind === "sound";
	}

	private engageTarget(context: UnitSimulationContext, zombie: Unit, target: UnitCombatTarget, dt: number) {
		const targetPoint = context.centerOf(target);
		const range = this.range + (target.size || 0.6);
		zombie.facing = targetPoint.x < zombie.x ? "left" : "right";
		if (context.distance(zombie, targetPoint) > range) {
			const movement = this.moveTowardGoal(context, zombie, targetPoint, dt);
			if (this.shouldAttackBlockedRoute(movement, zombie) && context.distance(zombie, targetPoint) > range) {
				context.attackBlockingBuilding(zombie, targetPoint);
			}
			return;
		}
		this.attackTarget(context, zombie, target);
	}

	private attackTarget(context: UnitSimulationContext, zombie: Unit, target: UnitCombatTarget) {
		if (zombie.cooldown > 0) return;
		context.damage(target, this.attack, zombie.ownerId);
		zombie.cooldown = this.cooldown;
		zombie.attackFlash = 0.22;
	}

	private targetOrBlockingBuilding(context: UnitSimulationContext, zombie: Unit, target: Unit): UnitCombatTarget {
		const targetPoint = context.centerOf(target);
		const range = this.range + (target.size || 0.6);
		if (context.hasReasonablePathToTarget(zombie, targetPoint, range)) return target;
		return context.blockingBuildingToward(zombie, targetPoint) || target;
	}

	private followHordeTarget(context: UnitSimulationContext, zombie: Unit, target: Vec2, dt: number) {
		const blockingBuilding = this.blockingBuildingTowardSound(context, zombie, target);
		if (blockingBuilding) {
			this.engageTarget(context, zombie, blockingBuilding, dt);
			return;
		}

		zombie.facing = target.x < zombie.x ? "left" : "right";
		if (context.distance(zombie, target) <= 0.45) {
			zombie.zombieStuckTicks = 0;
			zombie.zombiePath = null;
			zombie.zombiePathTarget = null;
			zombie.retargetIn = 0;
			return;
		}
		const movement = this.moveTowardGoal(context, zombie, target, dt);
		if (this.shouldAttackBlockedRoute(movement, zombie)) {
			context.attackBlockingBuilding(zombie, zombie.zombieHordeSourceTarget || target);
		}
		if (context.distance(zombie, target) >= 0.45) return;
		zombie.zombieStuckTicks = 0;
		zombie.retargetIn = 0;
	}

	private shouldAttackBlockedRoute(movement: { moved: boolean; pathFound: boolean; usedPath: boolean }, zombie: Unit) {
		return movement.usedPath && (!movement.pathFound || !movement.moved || (zombie.zombieStuckTicks || 0) >= ZOMBIE_PATH_STUCK_TICKS);
	}

	private blockingBuildingTowardSound(context: UnitSimulationContext, zombie: Unit, target: Vec2) {
		if (zombie.zombieGoalKind !== "sound") return null;
		const sourceTarget = zombie.zombieHordeSourceTarget || target;
		if (context.hasReasonablePathToTarget(zombie, sourceTarget, 0.45)) return null;
		return context.blockingBuildingToward(zombie, sourceTarget);
	}

	private findNearestUnitTarget(context: UnitSimulationContext, zombie: Unit, range: number): Unit | null {
		let best: Unit | null = null;
		let bestDist = range;
		for (const unit of context.nearbyTargetUnits(zombie, range)) {
			const d = context.distance(context.centerOf(zombie), context.centerOf(unit));
			if (d < bestDist) {
				best = unit;
				bestDist = d;
			}
		}
		return best;
	}

	private findNearestBuildingTarget(context: UnitSimulationContext, zombie: Unit, range: number): UnitCombatTarget | null {
		const target = context.nearestEnemy(zombie, range);
		return target?.kind === "building" ? target : null;
	}

	private didNotMove(context: UnitSimulationContext, before: Vec2, zombie: Unit) {
		return context.distance(before, zombie) <= 0.01;
	}

	private moveTowardGoal(context: UnitSimulationContext, zombie: Unit, target: Vec2, dt: number) {
		const before = { x: zombie.x, y: zombie.y };
		const beforeDistance = context.distance(before, target);
		const usedPath = (zombie.zombieStuckTicks || 0) >= ZOMBIE_PATH_STUCK_TICKS;
		if (usedPath) context.moveZombieWithPath(zombie, target, this.speed * dt);
		else {
			context.moveZombieSteered(zombie, target, this.speed * dt);
			zombie.zombiePath = null;
			zombie.zombiePathTarget = null;
		}
		const afterDistance = context.distance(zombie, target);
		const moved = !this.didNotMove(context, before, zombie);
		const madeProgress = afterDistance < beforeDistance - ZOMBIE_PROGRESS_EPSILON;
		const movedAroundObstacle = moved && afterDistance <= beforeDistance + ZOMBIE_SIDEWAYS_PROGRESS_TOLERANCE;
		if (moved) {
			this.rememberDriftDirection(context, zombie, before);
		}
		if (madeProgress || (!usedPath && movedAroundObstacle)) zombie.zombieStuckTicks = 0;
		else zombie.zombieStuckTicks = (zombie.zombieStuckTicks || 0) + 1;
		return { moved, pathFound: !usedPath || !!zombie.zombiePath, usedPath };
	}

	private rememberDriftDirection(context: UnitSimulationContext, zombie: Unit, before: Vec2) {
		const dx = zombie.x - before.x;
		const dy = zombie.y - before.y;
		const length = Math.hypot(dx, dy);

		zombie.zombieDriftDirection = {
			x: dx / length,
			y: dy / length,
		};
	}

	private driftForward(context: UnitSimulationContext, zombie: Unit, dt: number) {
		const direction = zombie.zombieDriftDirection;
		if (!direction) return;

		const target = {
			x: zombie.x + direction.x * 10,
			y: zombie.y + direction.y * 10,
		};
		zombie.facing = direction.x < 0 ? "left" : "right";
		this.moveTowardGoal(context, zombie, target, dt);
	}

	private clearMovementState(zombie: Unit) {
		zombie.zombieGoalKind = null;
		zombie.zombiePath = null;
		zombie.zombiePathTarget = null;
		zombie.zombieStuckTicks = 0;
		zombie.zombieDriftDirection = null;
		zombie.zombieHordeSourceTarget = null;
	}
}
