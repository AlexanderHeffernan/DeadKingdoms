import { BaseUnit } from "./BaseUnit.js";
import type { UnitCombatTarget, UnitSimulationContext } from "./BaseUnit.js";
import type { Building, Unit, Vec2 } from "../types.js";
import { MAP_SIZE } from "../config.js";

const ZOMBIE_TARGET_SIGHT_RANGE = 5.5;
const ZOMBIE_WANDER_RADIUS = 7;
const ZOMBIE_MOMENTUM_DISTANCE = 18;

export class ZombieUnit extends BaseUnit {
	public static readonly type = "zombie";
	public static readonly label = "Zombie";
	public static readonly sprite = "zombie";
	public static readonly stats = {
		maxHp: 34,
		speed: 1.35,
		attack: 5,
		range: 0.55,
		cooldown: 1.5,
		score: 0,
		trainTime: 0,
		cost: {},
		vision: 0,
		sound: 0,
	} as const;

	public step(context: UnitSimulationContext, zombie: Unit, dt: number) {
		this.updateTimers(zombie, dt);
		zombie.vision = this.stats.vision || 5;
		const target = this.findNearestTarget(context, zombie, ZOMBIE_TARGET_SIGHT_RANGE);
		if (target) {
			this.engageTarget(context, zombie, target, dt);
			return;
		}
		this.moveTowardCurrentGoal(context, zombie, dt);
	}

	private engageTarget(context: UnitSimulationContext, zombie: Unit, target: UnitCombatTarget, dt: number) {
		const targetPoint = context.centerOf(target);
		const range = this.stats.range + (target.size || 0.6);
		zombie.facing = targetPoint.x < zombie.x ? "left" : "right";
		zombie.soundTarget = this.extendDirection(zombie, targetPoint, ZOMBIE_MOMENTUM_DISTANCE);
		zombie.wanderTarget = null;
		if (context.distance(zombie, targetPoint) > range) {
			const blocked = context.moveUnit(zombie, targetPoint, this.stats.speed * dt);
			if (blocked && context.distance(zombie, targetPoint) > range) context.attackBlockingBuilding(zombie, targetPoint);
			return;
		}
		this.attackTarget(context, zombie, target);
	}

	private attackTarget(context: UnitSimulationContext, zombie: Unit, target: UnitCombatTarget) {
		if (zombie.cooldown > 0) return;
		context.damage(target, this.stats.attack, zombie.ownerId);
		zombie.cooldown = this.stats.cooldown;
		zombie.attackFlash = 0.22;
	}

	private moveTowardCurrentGoal(context: UnitSimulationContext, zombie: Unit, dt: number) {
		const moveTarget = zombie.soundTarget || zombie.wanderTarget || this.chooseWanderTarget(zombie);
		if (!moveTarget) return;
		if (!zombie.soundTarget && !zombie.wanderTarget) zombie.wanderTarget = moveTarget;
		zombie.facing = moveTarget.x < zombie.x ? "left" : "right";
		const arrived = context.moveUnit(zombie, moveTarget, this.stats.speed * dt);
		if (!arrived && context.distance(zombie, moveTarget) >= 0.45) return;
		const nextTarget = this.extendDirection(zombie, moveTarget, ZOMBIE_MOMENTUM_DISTANCE);
		if (zombie.soundTarget) zombie.soundTarget = nextTarget;
		else zombie.wanderTarget = nextTarget;
		zombie.retargetIn = 0;
	}

	private findNearestTarget(context: UnitSimulationContext, zombie: Unit, range: number): UnitCombatTarget | null {
		const unit = this.findNearestUnitTarget(context, zombie, range);
		return unit || this.findNearestTownCenterTarget(context, zombie, range);
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

	private findNearestTownCenterTarget(context: UnitSimulationContext, zombie: Unit, range: number): Building | null {
		let best: Building | null = null;
		let bestDist = range;
		for (const building of Object.values(context.world.buildings)) {
			if (!building.isTownCenter() || building.hp <= 0) continue;
			const d = context.distance(context.centerOf(zombie), context.centerOf(building));
			if (d < bestDist) {
				best = building;
				bestDist = d;
			}
		}
		return best;
	}

	private chooseWanderTarget(zombie: Unit) {
		const angle = Math.random() * Math.PI * 2;
		const radius = 2 + Math.random() * ZOMBIE_WANDER_RADIUS;
		return {
			x: this.clamp(zombie.x + Math.cos(angle) * radius, 0.5, MAP_SIZE - 0.5),
			y: this.clamp(zombie.y + Math.sin(angle) * radius, 0.5, MAP_SIZE - 0.5),
		};
	}

	private extendDirection(from: Vec2, toward: Vec2, distanceAhead: number) {
		const dx = toward.x - from.x;
		const dy = toward.y - from.y;
		const length = Math.hypot(dx, dy) || 1;
		return {
			x: this.clamp(toward.x + (dx / length) * distanceAhead, 0.5, MAP_SIZE - 0.5),
			y: this.clamp(toward.y + (dy / length) * distanceAhead, 0.5, MAP_SIZE - 0.5),
		};
	}

	private clamp(value: number, min: number, max: number) {
		return Math.max(min, Math.min(max, value));
	}
}
