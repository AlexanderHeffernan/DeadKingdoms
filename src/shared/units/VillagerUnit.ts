import { BaseUnit } from "./BaseUnit.js";
import type { UnitSimulationContext } from "./BaseUnit.js";
import type { Building, ResourceNode, Unit, UnitCommand } from "../types.js";

const TREE_STUMP_THRESHOLD = 36;

export class VillagerUnit extends BaseUnit {
	public static readonly type = "villager";
	public static readonly label = "Villager";
	public static readonly sprite = "villager";
	public static readonly trainShortcut = "V";
	public static readonly maxHp = 40;
	public static readonly speed = 3.2;
	public static readonly attack = 3;
	public static readonly range = 0.9;
	public static readonly cooldown = 1.1;
	public static readonly score = 10;
	public static readonly trainTime = 3.5;
	public static readonly cost = { food: 50 };
	public static readonly vision = 12;
	public static readonly sound = 6;
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

	private stepGather(context: UnitSimulationContext, unit: Unit, command: Extract<UnitCommand, { type: "gather" }>, dt: number) {
		let resource: ResourceNode | Building | null = context.gatherTarget(command.targetId, unit.ownerId);
		if (unit.carried && unit.carried.amount > 0) {
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
				command.targetId = next.id;
				command.path = null;
				command.progress = 0;
				return;
			}
			unit.command = { type: "idle" };
			return;
		}
		const targetPoint = context.isBuilding(resource) ? context.centerOf(resource) : resource;
		const gatherRange = context.gatherRange(resource);
		if (context.distance(unit, targetPoint) > gatherRange) {
			context.moveNearTarget(unit, command, targetPoint, gatherRange, this.speed * dt);
			return;
		}
		this.gatherFromTarget(context, unit, command, resource, targetPoint, dt);
	}

	private depositCarriedResource(context: UnitSimulationContext, unit: Unit, command: UnitCommand, dt: number) {
		if (!unit.carried) return;
		const depot = context.nearestDepot(unit.ownerId, unit.carried.resource, unit);
		if (!depot) return;
		if (context.distance(unit, context.centerOf(depot)) > depot.size + 0.7) {
			context.moveNearTarget(unit, command, context.centerOf(depot), depot.size + 0.7, this.speed * dt);
			return;
		}
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
		command.progress = (command.progress || 0) + dt;
		const gatherTarget = context.gatherTargetFor(resource);
		if (command.progress < this.gatherSeconds(gatherTarget)) return;
		const amount = Math.min(this.gatherAmount(gatherTarget), resource.amount!);
		resource.amount! -= amount;
		unit.carried = { resource: context.gatherResource(resource), amount };
		command.progress = 0;
		this.handleGatheredOutTarget(context, resource);
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
		} else if (resource.amount! <= 0) {
			context.deleteResource(resource);
		} else if (resource.type === "tree" && resource.amount! <= TREE_STUMP_THRESHOLD) {
			context.makeStump(resource);
		}
	}

	private stepBuild(context: UnitSimulationContext, unit: Unit, command: Extract<UnitCommand, { type: "build" }>, dt: number) {
		const building = context.buildingById(command.targetId);
		if (!building || building.ownerId !== unit.ownerId) {
			unit.command = { type: "idle" };
			return;
		}
		if (context.isComplete(building) && building.hp >= building.maxHp) {
			context.assignPostBuildGather(unit, command.resourceKind, command.gatherBuiltFarm ? building : null);
			return;
		}
		const targetPoint = context.centerOf(building);
		if (context.distance(unit, targetPoint) > building.size + 0.7) {
			context.moveNearTarget(unit, command, targetPoint, building.size + 0.7, this.speed * dt);
			return;
		}
		unit.workFlash = 0.2;
		context.emitActionSound("build", targetPoint);
		building.hp = Math.min(building.maxHp, building.hp + 76 * dt);
		if (building.hp >= building.maxHp) {
			building.markComplete();
			context.assignPostBuildGather(unit, command.resourceKind, command.gatherBuiltFarm ? building : null);
		}
	}
}
