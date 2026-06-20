import { parentPort } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { MAP_SIZE } from "../shared/config.js";
import { unitBehaviorFor } from "../shared/unitRegistry.js";
import type { UnitCombatTarget, UnitSimulationContext } from "../shared/units/index.js";
import type { Building, Corpse, Unit, Vec2, World } from "../shared/types.js";
import { distance, footprintHeight, footprintWidth } from "./math.js";
import { hasPathToInteractionRange, hasReasonableZombiePathToTarget, moveAroundSmallObstacle, moveNearTarget, moveUnit, moveWithPath, moveZombieSteered, moveZombieWithPath } from "./pathing.js";
import { SpatialGrid } from "./utils/SpatialGrid.js";
import { ZOMBIE_OWNER_ID } from "./zombieSpawning.js";
import type {
	ZombieAiAttackIntent,
	ZombieAiAttackRecorder,
	ZombieAiUnitState,
	ZombieAiWorkerRequest,
	ZombieAiWorkerResponse,
	ZombieAiWorkerSnapshot,
} from "./zombieAiWorkerProtocol.js";

const TARGET_UNIT_GRID_CELL_SIZE = 4;

if (!parentPort) throw new Error("Zombie AI worker requires a parent port.");

parentPort.on("message", (message: ZombieAiWorkerRequest) => {
	if (message.type !== "step") return;
	const { snapshot } = message;
	try {
		const startedAt = performance.now();
		const world = worldFromSnapshot(snapshot);
		const recorder = new ZombieAiAttackIntents(world);
		const context = createZombieSimulationContext(world, recorder);
		for (const step of snapshot.zombies) {
			const zombie = world.units[step.id];
			if (!zombie || zombie.ownerId !== ZOMBIE_OWNER_ID || zombie.hp <= 0) continue;
			unitBehaviorFor("zombie").step(context, zombie, step.dt);
		}
		const result = {
			id: snapshot.id,
			tick: snapshot.tick,
			durationMs: performance.now() - startedAt,
			units: snapshot.zombies
			.map((step) => world.units[step.id])
			.filter((unit): unit is Unit => !!unit)
			.map(zombieState),
			attacks: recorder.attacks,
		};
		parentPort!.postMessage({ type: "result", result } satisfies ZombieAiWorkerResponse);
	} catch (error) {
		parentPort!.postMessage({
			type: "error",
			id: snapshot.id,
			message: error instanceof Error ? error.message : String(error),
		} satisfies ZombieAiWorkerResponse);
	}
});

function worldFromSnapshot(snapshot: ZombieAiWorkerSnapshot): World {
	const world: World = {
		map: snapshot.map,
		players: {},
		units: snapshot.units,
		buildings: snapshot.buildings as World["buildings"],
		resources: {},
		ruins: {},
		corpses: snapshot.corpses,
		notices: [],
		adminLogs: [],
		actionNoises: [],
		leaderboard: [],
		tick: snapshot.tick,
		spawnTimers: {},
		serverPerf: { tps: 0, tickMs: 0, samples: [] },
	};
	if (snapshot.occupancy) world._occupancy = snapshot.occupancy;
	return world;
}

class ZombieAiAttackIntents implements ZombieAiAttackRecorder {
	public readonly attacks: ZombieAiAttackIntent[] = [];

	constructor(private readonly world: World) {}

	damage(target: Unit | Building | Corpse, amount: number, attackerId: Unit["ownerId"], attacker: Unit) {
		this.attacks.push({
			attackerId: attacker.id,
			targetId: target.id,
			amount,
			attackerOwnerId: attackerId,
			cooldown: unitBehaviorFor(attacker.type).cooldown,
			attackFlash: 0.22,
		});
	}

	attackBlockingBuilding(attacker: Unit, targetPoint: Vec2) {
		const building = blockingBuildingToward(this.world, attacker, targetPoint);
		if (!building || attacker.cooldown > 0) return;
		this.damage(building, unitBehaviorFor(attacker.type).attack, attacker.ownerId, attacker);
		attacker.cooldown = unitBehaviorFor(attacker.type).cooldown;
		attacker.attackFlash = 0.22;
	}
}

function createZombieSimulationContext(world: World, recorder: ZombieAiAttackRecorder): UnitSimulationContext {
	const buildingGrid = new SpatialGrid(
		Object.values(world.buildings).filter((building) => building.hp > 0),
		TARGET_UNIT_GRID_CELL_SIZE,
	);
	const targetUnitGrid = new SpatialGrid(
		Object.values(world.units).filter((unit) => unit.type !== "zombie" && unit.hp > 0),
		TARGET_UNIT_GRID_CELL_SIZE,
	);
	return {
		world,
		targetById: (targetId) => world.units[targetId] || world.buildings[targetId] || world.corpses[targetId as keyof typeof world.corpses] || null,
		buildingById: (buildingId) => world.buildings[buildingId] || null,
		isComplete: (building) => building.hp >= building.maxHp,
		unitSoundLevel: (unit) => unitBehaviorFor(unit.type).soundLevel(),
		moveWithPath: (unit, command, maxStep) => moveWithPath(world, unit, command, maxStep),
		moveNearTarget: (unit, command, target, range, maxStep) => moveNearTarget(world, unit, command, target, range, maxStep),
		moveUnit: (unit, target, maxStep) => moveUnit(world, unit, target, maxStep),
		moveZombieWithPath: (unit, target, maxStep) => moveZombieWithPath(world, unit, target, maxStep),
		moveZombieSteered: (unit, target, maxStep) => moveZombieSteered(world, unit, target, maxStep),
		moveAroundSmallObstacle: (unit, target, maxStep) => moveAroundSmallObstacle(world, unit, target, maxStep),
		centerOf,
		distance,
		nearestEnemy: (source, range) => nearestEnemy(world, buildingGrid, source, range),
		nearbyTargetUnits: (source, range) =>
			targetUnitGrid
			.nearby(source, range)
			.map((entry) => entry.item)
			.filter((unit) => world.units[unit.id] === unit && unit.type !== "zombie" && unit.hp > 0),
		nearestTargetUnit: (source, range) => nearestTargetUnit(world, targetUnitGrid, source, range),
		nearestTargetBuilding: (source, range) => nearestTargetBuilding(world, buildingGrid, source, range),
		damage: (target, amount, attackerId, attacker) => {
			if (attacker) recorder.damage(target, amount, attackerId, attacker);
		},
		emitActionSound: () => {},
		gatherTarget: () => null,
		gatherResource: () => "wood",
		gatherTargetFor: () => ({ gatherAmountFor: () => 0, gatherSecondsFor: () => 0 }),
		gatherRange: () => 1,
		isBuilding: (entity): entity is Building => entity?.kind === "building",
		nearestDepot: () => null,
		findNextResource: () => null,
		maybeAutoReplenishBuilding: () => {},
		deleteResource: () => {},
		makeStump: () => {},
		depositResource: () => {},
		findNextBuildSite: () => null,
		assignPostBuildGather: () => {},
		attackBlockingBuilding: (unit, targetPoint) => recorder.attackBlockingBuilding(unit, targetPoint),
		hasPathToTarget: (unit, targetPoint, range) => hasPathToInteractionRange(world, unit, targetPoint, range),
		hasReasonablePathToTarget: (unit, targetPoint, range) => hasReasonableZombiePathToTarget(world, unit, targetPoint, range),
		blockingBuildingToward: (unit, targetPoint) => blockingBuildingToward(world, unit, targetPoint),
	};
}

function nearestEnemy(world: World, buildingGrid: SpatialGrid<Building>, source: Unit | Building, range: number): UnitCombatTarget | null {
	return nearestTargetUnit(world, new SpatialGrid(Object.values(world.units).filter((unit) => unit.type !== source.type && unit.hp > 0), TARGET_UNIT_GRID_CELL_SIZE), source, range)
		|| nearestTargetBuilding(world, buildingGrid, source as Unit, range);
}

function nearestTargetUnit(world: World, targetUnitGrid: SpatialGrid<Unit>, source: Vec2, range: number) {
	let best: Unit | null = null;
	let bestDist = range;
	const sourceCenter = centerOf(source);
	targetUnitGrid.forNearby(sourceCenter, range, (entry) => {
		const unit = entry.item;
		if (unit.hp <= 0 || unit.type === "zombie" || world.units[unit.id] !== unit) return;
		const d = distance(sourceCenter, centerOf(unit));
		if (d < bestDist) {
			best = unit;
			bestDist = d;
		}
	});
	return best;
}

function nearestTargetBuilding(world: World, buildingGrid: SpatialGrid<Building>, source: Unit, range: number) {
	let best: Building | null = null;
	let bestDist = range;
	const sourceCenter = centerOf(source);
	buildingGrid.forNearby(sourceCenter, range, (entry) => {
		const building = entry.item;
		if (building.ownerId === source.ownerId || building.hp <= 0 || world.buildings[building.id] !== building) return;
		const d = distance(sourceCenter, centerOf(building));
		if (d < bestDist) {
			best = building;
			bestDist = d;
		}
	});
	return best;
}

function blockingBuildingToward(world: World, zombie: Unit, targetPoint: Vec2): Building | null {
	const dx = targetPoint.x - zombie.x;
	const dy = targetPoint.y - zombie.y;
	const length = Math.hypot(dx, dy) || 1;
	const step = 0.35;
	const blockingBuildings = blockingBuildingsByTile(world);
	for (let distanceToTarget = 0.65; distanceToTarget <= length; distanceToTarget += step) {
		const x = Math.floor(zombie.x + (dx / length) * distanceToTarget);
		const y = Math.floor(zombie.y + (dy / length) * distanceToTarget);
		const building = blockingBuildings.get(y * MAP_SIZE + x);
		if (building?.ownerId === zombie.ownerId) continue;
		if (building && building.hp > 0) return building;
	}
	return null;
}

function blockingBuildingsByTile(world: World): Map<number, Building> {
	const buildings = new Map<number, Building>();
	for (const building of Object.values(world.buildings)) {
		if (!building.walkBlocking || building.hp <= 0) continue;
		for (let dy = 0; dy < building.height; dy += 1) {
			for (let dx = 0; dx < building.width; dx += 1) {
				const x = building.x + dx;
				const y = building.y + dy;
				if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE) continue;
				buildings.set(y * MAP_SIZE + x, building);
			}
		}
	}
	return buildings;
}

function centerOf(entity: Vec2 & { size?: number; width?: number; height?: number }) {
	return {
		x: entity.x + footprintWidth(entity) / 2,
		y: entity.y + footprintHeight(entity) / 2,
	};
}

function zombieState(unit: Unit): ZombieAiUnitState {
	return {
		id: unit.id,
		x: unit.x,
		y: unit.y,
		command: unit.command,
		cooldown: unit.cooldown,
		attackFlash: unit.attackFlash,
		workFlash: unit.workFlash,
		facing: unit.facing,
		vision: unit.vision ?? null,
		hordeTarget: unit.hordeTarget ?? null,
		zombieGoalKind: unit.zombieGoalKind ?? null,
		zombiePath: unit.zombiePath ?? null,
		zombiePathTarget: unit.zombiePathTarget ?? null,
		zombieStuckTicks: unit.zombieStuckTicks ?? 0,
		retargetIn: unit.retargetIn ?? 0,
		hordeId: unit.hordeId ?? null,
		zombieDriftDirection: unit.zombieDriftDirection ?? null,
		zombieHordeSourceTarget: unit.zombieHordeSourceTarget ?? null,
	};
}
