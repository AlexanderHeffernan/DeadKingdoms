import { performance } from "node:perf_hooks";
import {
	ACTION_SOUND_DEFS,
	COLORS,
	MAP_SIZE,
	RESOURCE_DEFS,
	STARTING_RESOURCES,
	STARTING_UNITS,
	TICK_RATE,
} from "../shared/config.js";
import { BUILDING_DEFS, createBuildingEntity } from "../shared/buildingRegistry.js";
import { unitBehaviorFor } from "../shared/unitRegistry.js";
import type { UnitSimulationContext } from "../shared/units/index.js";
import type { GatherTarget } from "../shared/buildingDefinitions.js";
import { id } from "./id.js";
import { clamp, distance, rectsOverlap } from "./math.js";
import { findPath, isWalkable, moveAroundSmallObstacle, moveNearTarget, moveUnit, moveWithPath, resolveUnitSeparation } from "./pathing.js";
import { stepSpawner } from "./spawning.js";
import { SpatialGrid } from "./utils/SpatialGrid.js";
import { stepZombieDirector } from "./zombieDirector.js";
import { ZOMBIE_OWNER_ID, zombieSpawnPolicy } from "./zombieSpawning.js";
import type {
	BuildQueueItem,
	Building,
	BuildingId,
	BuildingType,
	CommandPayload,
	CommandResult,
	EntityId,
	Player,
	PlayerId,
	ResourceNode,
	ResourceType,
	Ruin,
	Unit,
	UnitId,
	UnitType,
	World,
} from "../shared/types.js";

const PLAYER_SPAWN_MARGIN = 34;
const MIN_PLAYER_SPAWN_DISTANCE = 54;
const PLAYER_SPAWN_ATTEMPTS = 220;
const STUMP_DECAY_SECONDS = 60;
const RUIN_DECAY_SECONDS = 60;
const ZOMBIE_INITIAL_RETARGET_SECONDS = 1.2;
const MAX_ACTION_NOISES = 240;
const SERVER_PERF_SMOOTHING = 0.1;
const TARGET_UNIT_GRID_CELL_SIZE = 4;

export function createWorld(): World {
	const world: World = {
		map: { size: MAP_SIZE },
		players: {},
		units: {},
		buildings: {},
		resources: {},
		ruins: {},
		notices: [],
		actionNoises: [],
		leaderboard: [],
		tick: 0,
		spawnTimers: {},
		serverPerf: { tps: TICK_RATE, tickMs: 0 },
	};
	seedResources(world);
	rebuildOccupancy(world);
	return world;
}

export function addPlayer(world: World, name: string, requestedColor: string | null = null): PlayerId {
	const activeCount = Object.values(world.players).filter((p) => !p.defeated).length;
	const playerId = id("p");
	const spawn = chooseSpawn(world, activeCount);
	const color: string = normalizeColor(requestedColor) || COLORS[activeCount % COLORS.length]!;
	world.players[playerId] = {
		id: playerId,
		name: name.slice(0, 18) || "Player",
		color,
		resources: { ...STARTING_RESOURCES },
		autoReplenishFarms: true,
		explored: new Set(),
		population: 0,
		popCap: 0,
		defeated: false,
		score: 0,
		joinedAt: Date.now(),
	};

	clearSpawnResources(world, spawn.x, spawn.y, 14);
	createBuilding(world, playerId, "townCenter", spawn.x, spawn.y, true);
	for (const unit of STARTING_UNITS) createUnit(world, playerId, unit.unitType, spawn.x + unit.x, spawn.y + unit.y);
	addLocalResources(world, spawn.x, spawn.y);
	notice(world, `${world.players[playerId]!.name} joined the world.`);
	recalcPlayer(world, playerId);
	updateLeaderboard(world);
	return playerId;
}

function clearSpawnResources(world: World, x: number, y: number, radius: number) {
	for (const resource of Object.values(world.resources)) {
		if (distance(resource, { x, y }) <= radius) {
			delete world.resources[resource.id];
		}
	}
}

export function removePlayer(world: World, playerId: PlayerId) {
	const player = world.players[playerId];
	if (!player) return;
	notice(world, `${player.name} left the world.`);
	destroyPlayerStuff(world, playerId);
	delete world.players[playerId];
	updateLeaderboard(world);
}

export function spawnZombieHorde(world: World, playerId: PlayerId, count: number): number {
	if (!world.players[playerId]) return 0;
	const safeCount = clamp(Math.floor(count), 1, 2000);
	for (let i = 0; i < safeCount; i += 1) {
		const point = randomZombieHordePoint(world);
		createZombie(world, point.x, point.y);
	}
	notice(world, `God mode spawned ${safeCount} zombies.`);
	return safeCount;
}

function randomZombieHordePoint(world: World): { x: number; y: number } {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const point = {
			x: randomInt(1, MAP_SIZE - 2) + 0.5,
			y: randomInt(1, MAP_SIZE - 2) + 0.5,
		};
		if (isWalkable(world, Math.floor(point.x), Math.floor(point.y))) return point;
	}
	return {
		x: randomInt(1, MAP_SIZE - 2) + 0.5,
		y: randomInt(1, MAP_SIZE - 2) + 0.5,
	};
}

export function command(world: World, playerId: PlayerId, body: CommandPayload): CommandResult {
	const player = world.players[playerId];
	if (!player || player.defeated) return { ok: false, error: "Player unavailable." };
	rebuildOccupancy(world);
	const handler = COMMAND_HANDLERS[body.type];
	if (!handler) return { ok: false, error: "Unknown command." };
	return handler(world, playerId, body as never);
}

export function stepWorld(world: World, dt: number) {
	const tickStartedAt = performance.now();
	updateServerTps(world, tickStartedAt);
	try {
		world.tick += 1;
		rebuildOccupancy(world);
		const context = createSimulationContext(world);
		stepActionNoises(world, dt);
		stepSpawner(context, zombieSpawnPolicy, dt);
		stepZombieDirector(world, dt);
		stepResourceDecay(world, dt);
		stepRuinDecay(world, dt);
		for (const unit of Object.values(world.units)) unitBehavior(unit).step(context, unit, dt);
		resolveUnitSeparation(world);
		for (const building of Object.values(world.buildings)) stepBuilding(world, building, dt);
		for (const playerId of Object.keys(world.players)) recalcPlayer(world, playerId);
		updateLeaderboard(world);
	} finally {
		updateServerTickDuration(world, performance.now() - tickStartedAt);
	}
}

type CommandHandler<T extends CommandPayload["type"]> = (
	world: World,
	playerId: PlayerId,
	body: Extract<CommandPayload, { type: T }>,
) => CommandResult;

const COMMAND_HANDLERS: { [K in CommandPayload["type"]]: CommandHandler<K> } = {
	move: commandMove,
	build: commandBuild,
	finishBuild: commandFinishBuild,
	deleteBuilding: commandDeleteBuilding,
	setRallyPoint: commandSetRallyPoint,
	train: commandTrain,
	attack: commandAttack,
	gather: commandGather,
	toggleAutoFarm: commandToggleAutoFarm,
	replenishFarm: commandReplenishFarm,
};

function updateServerTps(world: World, tickStartedAt: number) {
	const previousTickAt = world.serverPerf.lastTickAt;
	world.serverPerf.lastTickAt = tickStartedAt;
	if (previousTickAt === undefined) return;
	const instantTps = 1000 / Math.max(1, tickStartedAt - previousTickAt);
	world.serverPerf.tps = smoothMetric(world.serverPerf.tps, instantTps);
}

function updateServerTickDuration(world: World, tickMs: number) {
	world.serverPerf.tickMs = smoothMetric(world.serverPerf.tickMs, tickMs);
}

function smoothMetric(current: number, next: number) {
	if (current <= 0) return next;
	return current * (1 - SERVER_PERF_SMOOTHING) + next * SERVER_PERF_SMOOTHING;
}

function createSimulationContext(world: World): UnitSimulationContext & import("./zombieSpawning.js").ZombieSpawnContext {
	const targetUnitGrid = new SpatialGrid(
		Object.values(world.units).filter((unit) => unit.type !== "zombie" && unit.hp > 0),
		TARGET_UNIT_GRID_CELL_SIZE,
	);
	return {
		world,
		targetById: (targetId) => world.units[targetId as UnitId] || world.buildings[targetId as BuildingId] || null,
		buildingById: (buildingId) => world.buildings[buildingId as BuildingId] || null,
		isComplete,
		unitSoundLevel: (unit) => unitBehavior(unit).soundLevel(),
		moveWithPath: (unit, command, maxStep) => moveWithPath(world, unit, command, maxStep),
		moveNearTarget: (unit, command, target, range, maxStep) => moveNearTarget(world, unit, command, target, range, maxStep),
		moveUnit: (unit, target, maxStep) => moveUnit(world, unit, target, maxStep),
		moveAroundSmallObstacle: (unit, target, maxStep) => moveAroundSmallObstacle(world, unit, target, maxStep),
		centerOf,
		distance,
		nearestEnemy: (source, range) => nearestEnemy(world, source, range),
		nearbyTargetUnits: (source, range) =>
			targetUnitGrid
			.nearby(source, range)
			.map((entry) => entry.item)
			.filter((unit) => world.units[unit.id] === unit && unit.type !== "zombie" && unit.hp > 0),
		damage: (target, amount, attackerId) => damage(world, target, amount, attackerId),
		emitActionSound: (action, point) => emitActionSound(world, action, point),
		gatherTarget: (targetId, playerId) => world.resources[targetId as keyof typeof world.resources] || gatherableBuilding(world.buildings[targetId as BuildingId], playerId),
		gatherResource,
		gatherTargetFor,
		gatherRange: (entity) => (isBuilding(entity) ? entity.gatherRange() : 1.1),
		isBuilding,
		nearestDepot: (ownerId, resource, source) => nearestDepot(world, ownerId, resource, source),
		findNextResource: (unit, resourceKind) => findNextResource(world, unit, resourceKind),
		maybeAutoReplenishBuilding: (building) => maybeAutoReplenishBuilding(world, building),
		deleteResource: (resource) => {
			delete world.resources[resource.id];
		},
		makeStump,
		depositResource: (ownerId, resource, amount) => {
			world.players[ownerId]!.resources[resource] += amount;
		},
		findNextBuildSite: (unit) => findNextBuildSite(world, unit),
		assignPostBuildGather: (unit, resourceKind, builtFarm = null) => assignPostBuildGather(world, unit, resourceKind, builtFarm),
		attackBlockingBuilding: (unit, targetPoint) => attackBlockingBuilding(world, unit, targetPoint),
		createZombie: (point) => createZombie(world, point.x, point.y),
		isWalkable: (x, y) => isWalkable(world, x, y),
		weightedWorldSound: () => weightedWorldSound(world),
		unitVision: (unit) => unit.vision || unitBehavior(unit).stats.vision || 5,
		randomInt,
	};
}

function rebuildOccupancy(world: World) {
	const size = MAP_SIZE;
	if (!world._occupancy || world._occupancy.length !== size * size) {
		world._occupancy = new Uint8Array(size * size);
	} else {
		world._occupancy.fill(0);
	}
	const grid = world._occupancy;
	for (const resource of Object.values(world.resources)) {
		const x = Math.floor(resource.x);
		const y = Math.floor(resource.y);
		if (x >= 0 && y >= 0 && x < size && y < size) grid[y * size + x] = 1;
	}
	for (const building of Object.values(world.buildings)) {
		if (!building.isWalkBlocking()) continue;
		for (let dy = 0; dy < building.size; dy += 1) {
			for (let dx = 0; dx < building.size; dx += 1) {
				const x = building.x + dx;
				const y = building.y + dy;
				if (x >= 0 && y >= 0 && x < size && y < size) grid[y * size + x] = 1;
			}
		}
	}
}

function occupied(world: World, x: number, y: number): boolean {
	if (!world._occupancy) return false;
	if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE) return true;
	return world._occupancy[y * MAP_SIZE + x] === 1;
}

function seedResources(world: World) {
	for (let grove = 0; grove < 240; grove += 1) {
		const cx = 4 + Math.floor(Math.random() * (MAP_SIZE - 8));
		const cy = 4 + Math.floor(Math.random() * (MAP_SIZE - 8));
		const count = 12 + Math.floor(Math.random() * 18);
		for (let i = 0; i < count; i += 1) {
			const angle = Math.random() * Math.PI * 2;
			const radius = Math.random() * 6;
			createResource(world, "tree", cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
		}
	}
	for (let vein = 0; vein < 86; vein += 1) {
		const cx = 5 + Math.floor(Math.random() * (MAP_SIZE - 10));
		const cy = 5 + Math.floor(Math.random() * (MAP_SIZE - 10));
		for (let i = 0; i < 5 + Math.floor(Math.random() * 4); i += 1) {
			createResource(world, "ore", cx + Math.floor(Math.random() * 5) - 2, cy + Math.floor(Math.random() * 5) - 2);
		}
	}
	for (let patch = 0; patch < 124; patch += 1) {
		const cx = 5 + Math.floor(Math.random() * (MAP_SIZE - 10));
		const cy = 5 + Math.floor(Math.random() * (MAP_SIZE - 10));
		for (let i = 0; i < 4 + Math.floor(Math.random() * 4); i += 1) {
			createResource(world, "berry", cx + Math.floor(Math.random() * 4) - 2, cy + Math.floor(Math.random() * 4) - 2);
		}
	}
}

function addLocalResources(world: World, x: number, y: number) {
	const sx = x < MAP_SIZE / 2 ? 1 : -1;
	const sy = y < MAP_SIZE / 2 ? 1 : -1;
	const spots = [
		["tree", x + sx * 15, y + sy * 1] as const,
		["tree", x + sx * 16, y + sy * 2] as const,
		["tree", x + sx * 15, y + sy * 3] as const,
		["tree", x + sx * 17, y + sy * 3] as const,
		["tree", x + sx * 16, y + sy * 4] as const,
		["tree", x + sx * 18, y + sy * 4] as const,
		["berry", x + sx * 11, y + sy * 11] as const,
		["berry", x + sx * 12, y + sy * 12] as const,
		["berry", x + sx * 10, y + sy * 12] as const,
		["ore", x + sx * 4, y + sy * 15] as const,
		["ore", x + sx * 5, y + sy * 16] as const,
	];
	for (const [type, rx, ry] of spots) createResource(world, type as "tree" | "ore" | "berry", rx, ry);
}

function chooseSpawn(world: World, _count: number) {
	const existingTownCenters = Object.values(world.buildings).filter((building) => building.isTownCenter());
	let best = randomInteriorPoint();
	let bestScore = -Infinity;
	for (let attempt = 0; attempt < PLAYER_SPAWN_ATTEMPTS; attempt += 1) {
		const candidate = randomInteriorPoint();
		if (!canSpawnTownCenterAt(world, candidate.x, candidate.y)) continue;
		const nearestTownCenter = existingTownCenters.reduce((min, building) => Math.min(min, distance(candidate, centerOf(building))), Infinity);
		if (nearestTownCenter < MIN_PLAYER_SPAWN_DISTANCE) continue;
		const edgeDistance = Math.min(candidate.x, candidate.y, MAP_SIZE - candidate.x, MAP_SIZE - candidate.y);
		const centerDistance = distance(candidate, { x: MAP_SIZE / 2, y: MAP_SIZE / 2 });
		const score = nearestTownCenter + edgeDistance * 0.35 + Math.random() * 10 - centerDistance * 0.05;
		if (score > bestScore) {
			best = candidate;
			bestScore = score;
		}
	}
	return best;
}

function randomInteriorPoint() {
	return {
		x: PLAYER_SPAWN_MARGIN + Math.floor(Math.random() * (MAP_SIZE - PLAYER_SPAWN_MARGIN * 2)),
		y: PLAYER_SPAWN_MARGIN + Math.floor(Math.random() * (MAP_SIZE - PLAYER_SPAWN_MARGIN * 2)),
	};
}

function canSpawnTownCenterAt(world: World, x: number, y: number): boolean {
	const size = BUILDING_DEFS.townCenter.stats.size;
	if (x < PLAYER_SPAWN_MARGIN || y < PLAYER_SPAWN_MARGIN || x + size > MAP_SIZE - PLAYER_SPAWN_MARGIN || y + size > MAP_SIZE - PLAYER_SPAWN_MARGIN) return false;
	return Object.values(world.buildings).every((building) => !rectsOverlap({ x, y, size }, building));
}

function createUnit(world: World, ownerId: PlayerId, type: UnitType, x: number, y: number): Unit {
	const def = unitBehaviorFor(type);
	const unit: Unit = {
		id: id("u"),
		kind: "unit",
		ownerId,
		type,
		x,
		y,
		hp: def.stats.maxHp,
		maxHp: def.stats.maxHp,
		command: { type: "idle" },
		cooldown: 0,
		attackFlash: 0,
		workFlash: 0,
		facing: "right",
		carried: null,
		selected: false,
	};
	world.units[unit.id] = unit;
	return unit;
}

function createZombie(world: World, x: number, y: number): Unit {
	const zombie = createUnit(world, ZOMBIE_OWNER_ID, "zombie", x, y);
	zombie.retargetIn = Math.random() * ZOMBIE_INITIAL_RETARGET_SECONDS;
	return zombie;
}

function createBuilding(world: World, ownerId: PlayerId, type: BuildingType, x: number, y: number, free = false): Building | null {
	const def = BUILDING_DEFS[type];
	const building = createBuildingEntity(type, { id: id("b"), ownerId, x, y });
	if (!free && !spend(world.players[ownerId]!, def.stats.cost)) return null;
	world.buildings[building.id] = building;
	return building;
}

function createResource(world: World, type: keyof typeof RESOURCE_DEFS, x: number, y: number): ResourceNode | null {
	x = clamp(Math.round(x), 1, MAP_SIZE - 2);
	y = clamp(Math.round(y), 1, MAP_SIZE - 2);
	const blocked = [...Object.values(world.resources), ...Object.values(world.buildings)].some((entity) => pointInsideEntity(x, y, entity));
	if (blocked) return null;
	const def = RESOURCE_DEFS[type];
	const resource: ResourceNode = {
		id: id("r"),
		kind: "resource",
		type,
		x,
		y,
		amount: def.amount,
		maxAmount: def.amount,
		resource: def.resource,
		stage: type === "tree" ? "tree" : type,
		decay: 0,
	};
	world.resources[resource.id] = resource;
	return resource;
}

function createRuin(world: World, building: Building) {
	const ruinId = id("x");
	world.ruins[ruinId] = {
		id: ruinId,
		kind: "ruin",
		type: building.type,
		x: building.x,
		y: building.y,
		size: building.size,
		age: 0,
	};
}

function pointInsideEntity(x: number, y: number, entity: { x: number; y: number; size?: number }): boolean {
	const size = entity.size || 1;
	return x >= Math.floor(entity.x) && x < Math.floor(entity.x) + size && y >= Math.floor(entity.y) && y < Math.floor(entity.y) + size;
}

function commandMove(world: World, playerId: PlayerId, body: Extract<CommandPayload, { type: "move" }>): CommandResult {
	forOwnUnits(world, playerId, body.unitIds, (unit, index) => {
		const target = {
			x: clamp(Number(body.x) + (index % 3) * 0.25, 0, MAP_SIZE - 1),
			y: clamp(Number(body.y) + Math.floor(index / 3) * 0.25, 0, MAP_SIZE - 1),
		};
		unit.command = {
			type: "move",
			...target,
			path: findPath(world, unit, target),
		};
	});
	return { ok: true };
}

function commandAttack(world: World, playerId: PlayerId, body: Extract<CommandPayload, { type: "attack" }>): CommandResult {
	const target = world.units[body.targetId] || world.buildings[body.targetId];
	if (!target || target.ownerId === playerId) return { ok: false, error: "Invalid target." };
	let assigned = false;
	forOwnUnits(world, playerId, body.unitIds, (unit) => {
		unit.command = { type: "attack", targetId: target.id, path: null };
		assigned = true;
	});
	return assigned ? { ok: true } : { ok: false, error: "Select units to command." };
}

function commandGather(world: World, playerId: PlayerId, body: Extract<CommandPayload, { type: "gather" }>): CommandResult {
	const resource = world.resources[body.targetId] || gatherableBuilding(world.buildings[body.targetId], playerId);
	if (!resource) return { ok: false, error: "Invalid resource." };
	let assigned = false;
	forOwnUnits(world, playerId, body.unitIds, (unit) => {
		if (unitBehavior(unit).canGather()) {
			unit.command = {
				type: "gather",
				targetId: resource.id,
				// Remember what this worker was after so we can auto-find another
				// tree / ore vein / farm when the current target is gone.
				resourceKind: resource.resource!,
				progress: 0,
				path: null,
			};
			assigned = true;
		}
	});
	return assigned ? { ok: true } : { ok: false, error: "Select gather-capable units." };
}

function commandToggleAutoFarm(world: World, playerId: PlayerId): CommandResult {
	const player = world.players[playerId];
	if (!player) return { ok: false, error: "Player not found." };
	player.autoReplenishFarms = !player.autoReplenishFarms;
	return { ok: true, autoReplenishFarms: player.autoReplenishFarms };
}

function commandReplenishFarm(world: World, playerId: PlayerId, body: Extract<CommandPayload, { type: "replenishFarm" }>): CommandResult {
	const farm = world.buildings[body.farmId];
	if (!farm || farm.ownerId !== playerId || !farm.canBeGatheredBy(playerId)) return { ok: false, error: "Select one of your completed farms." };
	return replenishFarm(world, farm) ? { ok: true } : { ok: false, error: "Not enough wood to reseed farm." };
}

function commandBuild(world: World, playerId: PlayerId, body: Extract<CommandPayload, { type: "build" }>): CommandResult {
	const def = BUILDING_DEFS[body.buildingType];
	if (!def) return { ok: false, error: "Unknown building." };
	const x = clamp(Math.round(Number(body.x)), 0, MAP_SIZE - def.stats.size);
	const y = clamp(Math.round(Number(body.y)), 0, MAP_SIZE - def.stats.size);
	if (!canPlace(world, x, y, def.stats.size)) return { ok: false, error: "Blocked tile." };
	const builders = Object.values(world.units).filter(
		(unit) => unit.ownerId === playerId && body.unitIds?.includes(unit.id) && unitBehavior(unit).canBuild(),
	);
	if (builders.length === 0) return { ok: false, error: "Select build-capable units." };
	const building = createBuilding(world, playerId, body.buildingType, x, y);
	if (!building) return { ok: false, error: "Not enough resources." };
	building.hp = Math.max(12, Math.floor(building.maxHp * 0.25));
	building.builderIds = builders.map((unit) => unit.id);
	const resourceKind = building.depotGatherKind();
	for (const unit of builders) unit.command = { type: "build", targetId: building.id, path: null, resourceKind, gatherBuiltFarm: building.shouldGatherAfterBuild() };
	return { ok: true };
}

function commandFinishBuild(world: World, playerId: PlayerId, body: Extract<CommandPayload, { type: "finishBuild" }>): CommandResult {
	const building = world.buildings[body.buildingId];
	if (!building || building.ownerId !== playerId) return { ok: false, error: "Invalid building." };
	if (isComplete(building)) return { ok: false, error: "Building is already complete." };
	const builders = Object.values(world.units).filter(
		(unit) => unit.ownerId === playerId && body.unitIds?.includes(unit.id) && unitBehavior(unit).canBuild(),
	);
	if (builders.length === 0) return { ok: false, error: "Select build-capable units." };
	const resourceKind = building.depotGatherKind();
	building.builderIds = [...new Set([...(building.builderIds || []), ...builders.map((unit) => unit.id)])];
	for (const unit of builders) unit.command = { type: "build", targetId: building.id, path: null, resourceKind, gatherBuiltFarm: building.shouldGatherAfterBuild() };
	return { ok: true };
}

function commandDeleteBuilding(world: World, playerId: PlayerId, body: Extract<CommandPayload, { type: "deleteBuilding" }>): CommandResult {
	const building = world.buildings[body.buildingId];
	if (!building || building.ownerId !== playerId) return { ok: false, error: "Select one of your buildings." };
	createRuin(world, building);
	delete world.buildings[building.id];
	for (const unit of Object.values(world.units)) {
		if ("targetId" in unit.command && unit.command.targetId === building.id) unit.command = { type: "idle" };
	}
	return { ok: true };
}

function commandSetRallyPoint(world: World, playerId: PlayerId, body: Extract<CommandPayload, { type: "setRallyPoint" }>): CommandResult {
	const building = world.buildings[body.buildingId];
	if (!building || building.ownerId !== playerId || building.trainableUnits().length === 0) return { ok: false, error: "Select a production building." };
	building.rallyPoint = {
		x: clamp(Number(body.x), 0, MAP_SIZE - 1),
		y: clamp(Number(body.y), 0, MAP_SIZE - 1),
	};
	return { ok: true };
}

function commandTrain(world: World, playerId: PlayerId, body: Extract<CommandPayload, { type: "train" }>): CommandResult {
	const building = world.buildings[body.buildingId];
	const unitDef = unitBehaviorFor(body.unitType);
	if (!building || building.ownerId !== playerId || !isComplete(building) || !unitDef) {
		return { ok: false, error: "Cannot train there." };
	}
	if (!building.canTrain(body.unitType)) {
		return { ok: false, error: "Cannot train there." };
	}
	const player = world.players[playerId];
	if (!player) return { ok: false, error: "Player not found." };
	if (player.population >= player.popCap) return { ok: false, error: "Population cap reached." };
	if (building.queue.length >= 10) return { ok: false, error: "Training queue is full." };
	if (!spend(player, unitDef.stats.cost)) return { ok: false, error: "Not enough resources." };
	building.queue.push({ unitType: body.unitType, remaining: unitDef.stats.trainTime } as BuildQueueItem);
	return { ok: true };
}

function forOwnUnits(world: World, playerId: PlayerId, unitIds: UnitId[] | undefined, fn: (unit: Unit, index: number) => void) {
	if (!Array.isArray(unitIds)) return;
	unitIds.forEach((unitId, index) => {
		const unit = world.units[unitId];
		if (unit?.ownerId === playerId) fn(unit, index);
	});
}

function stepBuilding(world: World, building: Building, dt: number) {
	building.cooldown = Math.max(0, building.cooldown - dt);
	building.attackFlash = Math.max(0, (building.attackFlash || 0) - dt);
	if (!isComplete(building)) return;
	if (building.queue.length > 0) {
		const current = building.queue[0];
		if (current) current.remaining -= dt;
		emitActionSound(world, "trainUnit", centerOf(building));
		if (current && current.remaining <= 0) {
			const item = building.queue.shift();
			if (!item) return;
			const unit = createUnit(world, building.ownerId, item.unitType, building.x + building.size + 0.4, building.y + building.size + 0.2);
			if (building.rallyPoint) {
				unit.command = { type: "move", ...building.rallyPoint, path: findPath(world, unit, building.rallyPoint) };
			}
		}
	}
	const attack = building.attackStats();
	if (attack) {
		const target = nearestEnemy(world, building, attack.range);
		if (target && building.cooldown <= 0) {
			damage(world, target, attack.attack, building.ownerId);
			emitActionSound(world, "towerAttack", centerOf(building));
			building.cooldown = attack.cooldown;
			building.attackFlash = 0.22;
		}
	}
}

function attackBlockingBuilding(world: World, zombie: Unit, targetPoint: { x: number; y: number }) {
	const behavior = unitBehavior(zombie);
	const building = blockingBuildingToward(world, zombie, targetPoint);
	if (!building || zombie.cooldown > 0) return;
	damage(world, building, behavior.stats.attack, ZOMBIE_OWNER_ID);
	zombie.cooldown = behavior.stats.cooldown;
	zombie.attackFlash = 0.22;
}

function blockingBuildingToward(world: World, zombie: Unit, targetPoint: { x: number; y: number }): Building | null {
	const dx = targetPoint.x - zombie.x;
	const dy = targetPoint.y - zombie.y;
	const length = Math.hypot(dx, dy) || 1;
	const x = zombie.x + (dx / length) * 0.65;
	const y = zombie.y + (dy / length) * 0.65;
	return Object.values(world.buildings).find((building) => pointInsideEntity(Math.floor(x), Math.floor(y), building)) || null;
}

function stepResourceDecay(world: World, dt: number) {
	for (const resource of Object.values(world.resources)) {
		if (resource.stage !== "stump") continue;
		resource.decay = (resource.decay || 0) + dt;
		if (resource.decay >= STUMP_DECAY_SECONDS) delete world.resources[resource.id];
	}
}

function stepActionNoises(world: World, dt: number) {
	world.actionNoises = world.actionNoises.filter((noise) => {
		noise.remaining -= dt;
		return noise.remaining > 0;
	});
}

type ActionSoundKey = keyof typeof ACTION_SOUND_DEFS;

function emitActionSound(world: World, action: ActionSoundKey, point: { x: number; y: number }) {
	const def = ACTION_SOUND_DEFS[action];
	const existing = world.actionNoises.find((noise) => noise.action === action && distance(noise, point) <= 1.2);
	if (existing) {
		existing.x = point.x;
		existing.y = point.y;
		existing.sound = Math.max(existing.sound, def.sound);
		existing.remaining = Math.max(existing.remaining, def.duration);
		return;
	}
	world.actionNoises.push({ id: id("s"), action, x: point.x, y: point.y, sound: def.sound, remaining: def.duration });
	while (world.actionNoises.length > MAX_ACTION_NOISES) world.actionNoises.shift();
}

function stepRuinDecay(world: World, dt: number) {
	for (const ruin of Object.values(world.ruins)) {
		ruin.age = (ruin.age || 0) + dt;
		if (ruin.age >= RUIN_DECAY_SECONDS) delete world.ruins[ruin.id];
	}
}

function weightedWorldSound(world: World): { point: { x: number; y: number }; strength: number } | null {
	const sources: { point: { x: number; y: number }; strength: number }[] = [];
	let total = 0;
	const consider = (point: { x: number; y: number }, strength: number) => {
		if (strength <= 0) return;
		sources.push({ point, strength });
		total += strength;
	};
	for (const unit of Object.values(world.units)) {
		if (unit.ownerId === ZOMBIE_OWNER_ID) continue;
		consider(unit, unitBehavior(unit).soundLevel());
	}
	for (const building of Object.values(world.buildings)) {
		consider(centerOf(building), building.soundLevel());
	}
	for (const noise of world.actionNoises) {
		consider(noise, noise.sound);
	}
	if (sources.length === 0) return null;
	let roll = Math.random() * total;
	for (const source of sources) {
		roll -= source.strength;
		if (roll <= 0) return source;
	}
	return sources[sources.length - 1]!;
}

function randomInt(min: number, max: number) {
	return min + Math.floor(Math.random() * (max - min + 1));
}

function makeStump(resource: ResourceNode) {
	if (resource.stage === "stump") return;
	resource.stage = "stump";
	resource.type = "stump";
	resource.sprite = "stump";
	resource.decay = 0;
}

function assignPostBuildGather(world: World, unit: Unit, resourceKind: ResourceType | null, builtFarm: Building | null = null) {
	if (builtFarm && unitBehavior(unit).canGather() && isComplete(builtFarm)) {
		const resource = builtFarm.gatherResource();
		if (resource) {
			unit.command = { type: "gather", targetId: builtFarm.id, resourceKind: resource, progress: 0, path: null };
			return;
		}
	}
	const nextBuild = findNextBuildSite(world, unit);
	if (nextBuild) {
		nextBuild.builderIds = [...new Set([...(nextBuild.builderIds || []), unit.id])];
		unit.command = { type: "build", targetId: nextBuild.id, path: null, resourceKind: nextBuild.depotGatherKind(), gatherBuiltFarm: nextBuild.shouldGatherAfterBuild() };
		return;
	}
	if (!resourceKind || !unitBehavior(unit).canGather()) {
		unit.command = { type: "idle" };
		return;
	}
	const next = findNextResource(world, unit, resourceKind);
	unit.command = next ? { type: "gather", targetId: next.id, resourceKind, progress: 0, path: null } : { type: "idle" };
}

function findNextBuildSite(world: World, unit: Unit): Building | null {
	let bestInitiated = null;
	let bestInitiatedDist = Infinity;
	let bestNearby = null;
	let bestNearbyDist = 28;
	for (const building of Object.values(world.buildings)) {
		if (building.ownerId !== unit.ownerId || isComplete(building)) continue;
		const d = distance(unit, centerOf(building));
		if (building.builderIds?.includes(unit.id) && d < bestInitiatedDist) {
			bestInitiated = building;
			bestInitiatedDist = d;
		}
		if (d < bestNearbyDist) {
			bestNearby = building;
			bestNearbyDist = d;
		}
	}
	return bestInitiated || bestNearby;
}

function findNextResource(world: World, unit: Unit, resourceKind: ResourceType | null): ResourceNode | Building | null {
	if (!resourceKind) return null;
	const RANGE = 30;
	let best = null;
	let bestDist = RANGE;
	for (const r of Object.values(world.resources)) {
		if (r.amount <= 0 || r.resource !== resourceKind) continue;
		const d = distance(unit, r);
		if (d < bestDist) {
			best = r;
			bestDist = d;
		}
	}
	for (const b of Object.values(world.buildings)) {
		if (!b.canBeGatheredBy(unit.ownerId) || b.gatherResource() !== resourceKind || b.isGatherExhausted()) continue;
		const d = distance(unit, b);
		if (d < bestDist) {
			best = b;
			bestDist = d;
		}
	}
	return best;
}

function nearestDepot(world: World, ownerId: PlayerId, resource: ResourceType, source: { x: number; y: number }) {
	let best = null;
	let bestDist = Infinity;
	for (const building of Object.values(world.buildings)) {
		if (building.ownerId !== ownerId || !isComplete(building) || !building.canAcceptResource(resource)) continue;
		const d = distance(source, centerOf(building));
		if (d < bestDist) {
			best = building;
			bestDist = d;
		}
	}
	return best;
}

function gatherableBuilding(building: Building | undefined, playerId: PlayerId): Building | null {
	if (!building?.canBeGatheredBy(playerId)) return null;
	return building;
}

function maybeAutoReplenishBuilding(world: World, building: Building) {
	const player = world.players[building.ownerId];
	if (!player) return;
	building.maybeReplenish((cost) => spend(player, cost), player.autoReplenishFarms);
}

function replenishFarm(world: World, building: Building): boolean {
	const player = world.players[building.ownerId];
	if (!player) return false;
	return building.maybeReplenish((cost) => spend(player, cost), true);
}

function nearestEnemy(world: World, source: Unit | Building, range: number) {
	let best = null;
	let bestDist = range;
	for (const entity of [...Object.values(world.units), ...Object.values(world.buildings)]) {
		if (entity.ownerId === source.ownerId || entity.hp <= 0) continue;
		const d = distance(centerOf(source), centerOf(entity));
		if (d < bestDist) {
			best = entity;
			bestDist = d;
		}
	}
	return best;
}

function isBuilding(entity: ResourceNode | Building | null | undefined): entity is Building {
	return entity?.kind === "building";
}

function gatherResource(entity: ResourceNode | Building): ResourceType {
	if (isBuilding(entity)) return entity.gatherResource()!;
	return entity.resource;
}

function gatherTargetFor(entity: ResourceNode | Building): GatherTarget {
	if (isBuilding(entity)) return entity;
	return {
		gatherAmountFor: (unit) => unit.carryCapacity(),
		gatherSecondsFor: () => 1.1,
	};
}

function damage(world: World, target: Unit | Building, amount: number, attackerId: PlayerId) {
	target.hp -= amount;
	if (target.hp > 0) return;
	if (target.kind === "building") {
		emitActionSound(world, "buildingDestroyed", centerOf(target));
		createRuin(world, target);
		delete world.buildings[target.id];
		if (target.isTownCenter()) defeatPlayer(world, target.ownerId, attackerId);
	} else {
		const shouldTurn = attackerId === ZOMBIE_OWNER_ID && target.ownerId !== ZOMBIE_OWNER_ID;
		const deathPoint = { x: target.x, y: target.y };
		delete world.units[target.id];
		if (shouldTurn) createZombie(world, deathPoint.x, deathPoint.y);
	}
}

function defeatPlayer(world: World, playerId: PlayerId, attackerId: PlayerId) {
	const player = world.players[playerId];
	if (!player || player.defeated) return;
	player.defeated = true;
	const attacker = world.players[attackerId];
	notice(world, `${player.name}'s town center was destroyed${attacker ? ` by ${attacker.name}` : ""}.`);
	destroyPlayerStuff(world, playerId);
}

function destroyPlayerStuff(world: World, playerId: PlayerId) {
	for (const unit of Object.values(world.units)) {
		if (unit.ownerId === playerId) delete world.units[unit.id];
	}
	for (const building of Object.values(world.buildings)) {
		if (building.ownerId === playerId) {
			createRuin(world, building);
			delete world.buildings[building.id];
		}
	}
}

function canPlace(world: World, x: number, y: number, size: number): boolean {
	if (x < 0 || y < 0 || x + size > MAP_SIZE || y + size > MAP_SIZE) return false;
	for (const building of Object.values(world.buildings)) {
		if (rectsOverlap({ x, y, size }, building)) return false;
	}
	for (let dy = 0; dy < size; dy += 1) {
		for (let dx = 0; dx < size; dx += 1) {
			if (occupied(world, x + dx, y + dy)) return false;
		}
	}
	return true;
}

function centerOf(entity: { x: number; y: number; size?: number }) {
	const offset = entity.size ? (entity.size - 1) / 2 : 0;
	return { x: entity.x + offset, y: entity.y + offset };
}

function spend(player: Player, cost: Partial<Record<ResourceType, number>> = {}): boolean {
	const entries = Object.entries(cost) as [ResourceType, number][];
	for (const [resource, amount] of entries) {
		if ((player.resources[resource] || 0) < amount) return false;
	}
	for (const [resource, amount] of entries) player.resources[resource] -= amount;
	return true;
}

function recalcPlayer(world: World, playerId: PlayerId) {
	const player = world.players[playerId];
	if (!player) return;
	const units = Object.values(world.units).filter((unit) => unit.ownerId === playerId);
	const buildings = Object.values(world.buildings).filter((building) => building.ownerId === playerId);
	player.population = units.length;
	player.popCap = 4 + buildings.filter(isComplete).reduce((sum, building) => {
		return sum + building.populationCapacity();
	}, 0);
	const unitScore = units.reduce((sum, unit) => sum + unitBehavior(unit).stats.score, 0);
	const buildingScore = buildings.reduce((sum, building) => sum + BUILDING_DEFS[building.type].stats.score, 0);
	const resourceScore = Math.floor(Object.values(player.resources).reduce((sum, amount) => sum + amount, 0) / 8);
	player.score = player.defeated ? 0 : unitScore + buildingScore + resourceScore;
}

function isComplete(building: Building): boolean {
	return building.isComplete();
}

function updateLeaderboard(world: World) {
	world.leaderboard = Object.values(world.players)
		.filter((player) => !player.defeated)
		.map((player) => ({ id: player.id, name: player.name, color: player.color, score: player.score, defeated: player.defeated, joinedAt: player.joinedAt }))
		.sort((a, b) => b.score - a.score);
}

function notice(world: World, text: string) {
	world.notices.push({ id: id("n"), text, at: Date.now() });
}

function normalizeColor(value: unknown): string | null {
	if (typeof value !== "string") return null;
	return /^#[0-9a-f]{6}$/i.test(value) ? value : null;
}

function unitBehavior(unit: Unit) {
	return unitBehaviorFor(unit.type);
}
