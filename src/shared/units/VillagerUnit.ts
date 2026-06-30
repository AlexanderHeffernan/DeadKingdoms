import { BaseUnit } from "./BaseUnit.js";
import type { UnitSimulationContext } from "./BaseUnit.js";
import type { Building, ResourceNode, Unit, UnitCommand } from "../types.js";

const TREE_STUMP_THRESHOLD = 36;
const GATHER_RETARGET_STUCK_TICKS = 45;
const GATHER_EPSILON = 0.001;
const VILLAGER_RESOURCE_INTERACTION_RANGE = 1.1;
const VILLAGER_PREFERRED_WORK_DISTANCE = 0.5;
const VILLAGER_WORK_POINT_RANGE = 0.55;

export class VillagerUnit extends BaseUnit {
	public static readonly type = "villager";
	public static readonly label = "Villager";
	public static readonly sprite = "villager";
	public static readonly trainShortcut = "V";
	public static readonly maxHp = 40;
	public static readonly speed = 3.2;
	public static readonly attack = 1;
	public static readonly range = 0.9;
	public static readonly cooldown = 1.1;
	public static readonly score = 10;
	public static readonly trainTime = 3.5;
	public static readonly cost = { food: 50 };
	public static readonly vision = 12;
	public static readonly sound = 0.5;
	public static readonly canGather = true;
	public static readonly canBuild = true;
	public static readonly carryCapacity = 20;

	public step(context: UnitSimulationContext, unit: Unit, dt: number) {
		const command = unit.command || { type: "idle" };
		if (command.type === "gather" || command.type === "build") {
			this.updateTimers(unit, dt);
			unit.vision = this.vision || 5;
			if (command.type === "gather") this.stepGather(context, unit, command, dt);
				else this.stepBuild(context, unit, command, dt);
		}
		else super.step(context, unit, dt);
	}

	public onAttacked(context: Pick<UnitSimulationContext, "setCommand">, unit: Unit, attacker: Unit) {
		if (attacker.ownerId === unit.ownerId || attacker.hp <= 0) return;
		if (unit.command.type !== "idle" && unit.command.type !== "gather" && unit.command.type !== "build") return;
		context.setCommand(unit, { type: "attack", targetId: attacker.id });
	}

	private stepGather(context: UnitSimulationContext, unit: Unit, command: Extract<UnitCommand, { type: "gather" }>, dt: number) {
		let resource: ResourceNode | Building | null = context.gatherTarget(command.targetId, unit.ownerId);
		if (this.hasReadyGatherLoad(unit, command)) {
			this.depositCarriedResource(context, unit, command, dt);
			return;
		}
		if (!resource || resource.amount! <= 0) {
			if (context.isBuilding(resource)) {
				context.maybeAutoReplenishBuilding(resource);
				if (resource.amount! > 0) return;
			}
			const next = context.findNextResource(unit, command.resourceKind);
			if (next) {
				context.setCommand(unit, { type: "gather", targetId: next.id, resourceKind: command.resourceKind, progress: 0, path: null });
				return;
			}
			context.setCommand(unit, { type: "idle" });
			return;
		}
		const targetPoint = context.isBuilding(resource) ? context.centerOf(resource) : resource;
		const gatherRange = context.isBuilding(resource)
			? context.gatherRange(resource)
			: VILLAGER_RESOURCE_INTERACTION_RANGE;
		if (!this.canWorkFromHere(unit, resource, gatherRange)) {
			const workPoint = this.workPointFor(unit, resource);
			const arrived = context.moveNearTarget(unit, command, workPoint, Math.min(gatherRange, VILLAGER_WORK_POINT_RANGE), this.speed * dt);
			if (!this.canWorkFromHere(unit, resource, gatherRange)) {
				if (!arrived) this.retargetBlockedGather(context, unit, command, resource);
				return;
			}
		}
		this.settleForWork(command);
		this.gatherFromTarget(context, unit, command, resource, targetPoint, dt);
	}

	private depositCarriedResource(context: UnitSimulationContext, unit: Unit, command: UnitCommand, dt: number) {
		if (!unit.carried) return;
		const depot = context.nearestDepot(unit.ownerId, unit.carried.resource, unit);
		if (!depot) return;
		const depositRange = depot.size + 0.7;
		if (!this.canWorkFromHere(unit, depot, depositRange)) {
			context.moveNearTarget(unit, command, this.workPointFor(unit, depot), VILLAGER_WORK_POINT_RANGE, this.speed * dt);
			return;
		}
		this.settleForWork(command);
		context.depositResource(unit.ownerId, unit.carried.resource, unit.carried.amount);
		unit.carried = null;
	}

	private gatherFromTarget(
		context: UnitSimulationContext,
		unit: Unit,
		command: Extract<UnitCommand, { type: "gather" }>,
		resource: ResourceNode | Building,
		targetPoint: { x: number; y: number },
		dt: number,
	) {
		unit.workFlash = 0.25;
		this.emitGatherSound(context, resource, targetPoint);
		const gatherTarget = context.gatherTargetFor(resource);
		const loadTarget = this.gatherAmount(gatherTarget);
		const gatherSeconds = this.gatherSeconds(gatherTarget);
		const carriedResource = context.gatherResource(resource);
		const carriedAmount = unit.carried?.resource === carriedResource ? unit.carried.amount : 0;
		const remainingLoad = Math.max(0, loadTarget - carriedAmount);
		const gathered = Math.min((loadTarget / gatherSeconds) * dt, remainingLoad, resource.amount!);
		if (gathered <= 0) {
			command.progress = 0;
			this.handleGatheredOutTarget(context, resource);
			return;
		}
		resource.amount! -= gathered;
		const nextAmount = carriedAmount + gathered;
		unit.carried = { resource: carriedResource, amount: nextAmount };
		if (nextAmount + GATHER_EPSILON >= loadTarget || resource.amount! <= GATHER_EPSILON) {
			command.progress = 0;
			this.handleGatheredOutTarget(context, resource);
			return;
		}
		command.progress = Math.min(gatherSeconds, (nextAmount / loadTarget) * gatherSeconds);
	}

	private hasReadyGatherLoad(unit: Unit, command: Extract<UnitCommand, { type: "gather" }>) {
		return !!unit.carried && unit.carried.amount > GATHER_EPSILON && (command.progress || 0) <= 0;
	}

	private retargetBlockedGather(
		context: UnitSimulationContext,
		unit: Unit,
		command: Extract<UnitCommand, { type: "gather" }>,
		resource: ResourceNode | Building,
	) {
		if ((command.moveStuckTicks || 0) < GATHER_RETARGET_STUCK_TICKS) return;
		const next = context.findAlternateResource(unit, command.resourceKind, resource);
		if (!next) return;
		context.setCommand(unit, {
			type: "gather",
			targetId: next.id,
			resourceKind: command.resourceKind,
			progress: 0,
			path: null,
		});
	}

	private emitGatherSound(context: UnitSimulationContext, resource: ResourceNode | Building, point: { x: number; y: number }) {
		const kind = context.gatherResource(resource);
		if (kind === "wood") context.emitActionSound("chopWood", point);
			else if (kind === "ore") context.emitActionSound("mineOre", point);
				else context.emitActionSound("gatherFood", point);
	}

	private handleGatheredOutTarget(context: UnitSimulationContext, resource: ResourceNode | Building) {
		if (context.isBuilding(resource)) {
			resource.onGatheredOut();
			context.maybeAutoReplenishBuilding(resource);
		} else if (resource.amount! <= GATHER_EPSILON) {
			context.deleteResource(resource);
		} else if (resource.type === "tree" && resource.amount! <= TREE_STUMP_THRESHOLD) {
			context.makeStump(resource);
		}
	}

	private stepBuild(context: UnitSimulationContext, unit: Unit, command: Extract<UnitCommand, { type: "build" }>, dt: number) {
		const building = context.buildingById(command.targetId);
		if (!building || building.ownerId !== unit.ownerId) {
			context.setCommand(unit, { type: "idle" });
			return;
		}
		if (context.isComplete(building) && building.hp >= building.maxHp) {
			context.assignPostBuildGather(unit, command.resourceKind, command.gatherBuiltFarm ? building : null);
			return;
		}
		const targetPoint = context.centerOf(building);
		const buildRange = building.size + 0.7;
		if (!this.canWorkFromHere(unit, building, buildRange)) {
			const arrived = context.moveNearTarget(unit, command, this.workPointFor(unit, building), Math.min(buildRange, VILLAGER_WORK_POINT_RANGE), this.speed * dt);
			if (!arrived || !this.canWorkFromHere(unit, building, buildRange)) return;
		}
		this.settleForWork(command);
		unit.workFlash = 0.2;
		context.emitActionSound("build", targetPoint);
		building.hp = Math.min(building.maxHp, building.hp + 76 * dt);
		if (building.hp >= building.maxHp) {
			building.markComplete();
			context.assignPostBuildGather(unit, command.resourceKind, command.gatherBuiltFarm ? building : null);
		}
	}

	private canWorkFromHere(unit: Unit, target: ResourceNode | Building, range: number) {
		return this.distanceToFootprint(unit, target) <= range;
	}

	private settleForWork(command: UnitCommand) {
		command.path = null;
		command.moveStuckTicks = 0;
		delete command.interactionBestCost;
		delete command.interactionTargetKey;
	}

	private workPointFor(unit: Unit, target: ResourceNode | Building) {
		const footprint = this.footprintBounds(target);
		const nearest = {
			x: Math.min(Math.max(unit.x, footprint.minX), footprint.maxX),
			y: Math.min(Math.max(unit.y, footprint.minY), footprint.maxY),
		};
		let dx = unit.x - nearest.x;
		let dy = unit.y - nearest.y;
		let length = Math.hypot(dx, dy);
		if (length <= 0.001) {
			const center = {
				x: (footprint.minX + footprint.maxX) / 2,
				y: (footprint.minY + footprint.maxY) / 2,
			};
			dx = unit.x - center.x || 1;
			dy = unit.y - center.y;
			length = Math.hypot(dx, dy) || 1;
		}
		return {
			x: nearest.x + (dx / length) * VILLAGER_PREFERRED_WORK_DISTANCE,
			y: nearest.y + (dy / length) * VILLAGER_PREFERRED_WORK_DISTANCE,
		};
	}

	private distanceToFootprint(point: { x: number; y: number }, target: ResourceNode | Building) {
		const footprint = this.footprintBounds(target);
		const dx = point.x < footprint.minX ? footprint.minX - point.x : point.x > footprint.maxX ? point.x - footprint.maxX : 0;
		const dy = point.y < footprint.minY ? footprint.minY - point.y : point.y > footprint.maxY ? point.y - footprint.maxY : 0;
		return Math.hypot(dx, dy);
	}

	private footprintBounds(target: ResourceNode | Building) {
		// Simulation occupancy is tile-top-left / floor-based: a footprint at
		// (x, y) occupies the half-open region [x, x+w) × [y, y+h). Buildings and
		// resources are placed on integer tile coords, so this matches the actual
		// blocked tile(s) exactly. Do NOT use an `x - 0.5` centered convention here
		// — that would shift the footprint half a tile away from the real obstacle
		// and produce work-points on grid intersections, which the floor-based
		// interaction flow field cannot resolve cleanly (causing approach
		// vibration, most visibly when approaching from screen-below).
		const width = "width" in target && typeof target.width === "number" ? target.width : 1;
		const height = "height" in target && typeof target.height === "number" ? target.height : 1;
		return {
			minX: target.x,
			maxX: target.x + width,
			minY: target.y,
			maxY: target.y + height,
		};
	}
}
