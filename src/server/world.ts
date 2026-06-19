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
import { BUILDING_TYPES, createBuilding as createBuildingInstance } from "../shared/buildings/index.js";
import { buildSoundField, collectWorldSoundSources } from "../shared/soundField.js";
import { unitBehaviorFor } from "../shared/unitRegistry.js";
import type { UnitSimulationContext } from "../shared/units/index.js";
import type { GatherTarget } from "../shared/buildings/base/index.js";
import { id } from "./id.js";
import { clamp, distance, footprintHeight, footprintWidth, rectsOverlap, type Footprint } from "./math.js";
import { isWalkable, moveAroundSmallObstacle, moveNearTarget, moveUnit, moveWithPath, moveZombieSteered, moveZombieWithPath, resolveUnitSeparation } from "./pathing.js";
import { stepSpawner } from "./spawning.js";
import { SpatialGrid } from "./utils/SpatialGrid.js";
import { stepZombieDirector } from "./zombieDirector.js";
import { ZOMBIE_OWNER_ID, zombieSpawnPolicy } from "./zombieSpawning.js";
import { Logs } from "../shared/logs.js";
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
	Vec2,
	World,
} from "../shared/types.js";

const PLAYER_SPAWN_MARGIN = 34;
const MIN_PLAYER_SPAWN_DISTANCE = 54;
const PLAYER_SPAWN_ATTEMPTS = 220;
const STUMP_DECAY_SECONDS = 60;
const RUIN_DECAY_SECONDS = 60;
const ZOMBIE_INITIAL_RETARGET_SECONDS = 1.2;
const MAX_ACTION_NOISES = 240;
// Very loud so the sound field overflow spreads across roughly half the map (~100 tile radius).
const DEV_BANG_SOUND = 13333.333333333334;
const DEV_BANG_DURATION = 2.5;
const MAX_ADMIN_LOGS = 500;
const SERVER_PERF_SMOOTHING = 0.1;
const SERVER_PERF_SAMPLE_LIMIT = TICK_RATE * 120;
const TARGET_UNIT_GRID_CELL_SIZE = 4;
const COMMAND_CLUSTER_DISTANCE = 12;
const FOREST_COUNT = 71;
const LONE_TREE_COUNT = 269;
const FOREST_MIN_RADIUS = 4;
const FOREST_RADIUS_VARIANCE = 12;
const ORE_VEIN_COUNT = 43;
const BERRY_PATCH_COUNT = 62;
const RESOURCE_PILE_PLACEMENT_ATTEMPTS = 80;
const RESOURCE_CLUSTER_GAP = 2;
const RESOURCE_CLUSTER_SEED_ATTEMPT_MULTIPLIER = 8;

export function createWorld(): World {
	const world: World = {
		map: { size: MAP_SIZE },
		players: {},
		units: {},
		buildings: {},
		resources: {},
		ruins: {},
		notices: [],
		adminLogs: [],
		actionNoises: [],
		leaderboard: [],
		tick: 0,
		spawnTimers: {},
		serverPerf: { tps: TICK_RATE, tickMs: 0, samples: [] },
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
	Logs.log(`${world.players[playerId]!.name} joined the world.`);
	recalcPlayer(world, playerId);
	updateLeaderboard(world);
	return playerId;
}

export function addAdminLog(world: World, source: string, message: string, at = Date.now()) {
	world.adminLogs.push({
		id: id("log"),
		at,
		source,
		message: message.slice(0, 500),
	});
	if (world.adminLogs.length > MAX_ADMIN_LOGS) {
		world.adminLogs.splice(0, world.adminLogs.length - MAX_ADMIN_LOGS);
	}
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
	Logs.log(`${player.name} left the world.`);
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
	notice(world, `Admin deployed ${safeCount} hostile units.`);
	return safeCount;
}

export function grantPlayerSoldiers(world: World, playerId: PlayerId, count: number): number {
	if (!world.players[playerId]) return 0;
	const safeCount = clamp(Math.floor(count), 1, 500);
	const origin = playerSpawnCenter(world, playerId);
	const existingSoldiers = Object.values(world.units).filter((unit) => unit.ownerId === playerId && unit.type === "soldier").length;
	let granted = 0;
	for (let i = 0; i < safeCount; i += 1) {
		const point = soldierGrantPoint(world, origin, existingSoldiers + i);
		createUnit(world, playerId, "soldier", point.x, point.y);
		granted += 1;
	}
	notice(world, `Dev command granted ${granted} soldiers.`);
	recalcPlayer(world, playerId);
	updateLeaderboard(world);
	return granted;
}

/** Dev tool: toggles invincibility on the player's town center and returns the new state. */
export function toggleTownCenterInvincibility(world: World, playerId: PlayerId): boolean | null {
	const townCenter = Object.values(world.buildings).find((building) => building.ownerId === playerId && building.type === "townCenter");
	if (!townCenter) return null;
	townCenter.invincible = !townCenter.invincible;
	return townCenter.invincible;
}

/** Dev tool: emits a one-off loud "bang" at a map point so zombies are drawn to it. */
export function emitDevBang(world: World, x: number, y: number): void {
	const point = { x: clamp(x, 0, MAP_SIZE), y: clamp(y, 0, MAP_SIZE) };
	const existing = world.actionNoises.find((noise) => noise.action === "devBang");
	if (existing) {
		existing.x = point.x;
		existing.y = point.y;
		existing.sound = DEV_BANG_SOUND;
		existing.remaining = DEV_BANG_DURATION;
		return;
	}
	world.actionNoises.push({ id: id("s"), action: "devBang", x: point.x, y: point.y, sound: DEV_BANG_SOUND, remaining: DEV_BANG_DURATION });
	while (world.actionNoises.length > MAX_ACTION_NOISES) world.actionNoises.shift();
}

function playerSpawnCenter(world: World, playerId: PlayerId) {
	const townCenter = Object.values(world.buildings).find((building) => building.ownerId === playerId && building.type === "townCenter");
	if (townCenter) return centerOf(townCenter);
	const building = Object.values(world.buildings).find((entity) => entity.ownerId === playerId);
	if (building) return centerOf(building);
	const unit = Object.values(world.units).find((entity) => entity.ownerId === playerId);
	return unit ? { x: unit.x, y: unit.y } : { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };
}

function soldierGrantPoint(world: World, origin: { x: number; y: number }, index: number) {
	const columns = 24;
	const spacing = 0.9;
	const row = Math.floor(index / columns);
	const column = index % columns;
	const base = {
		x: origin.x + (column - (columns - 1) / 2) * spacing,
		y: origin.y + 3 + row * spacing,
	};
	if (isWalkable(world, Math.floor(base.x), Math.floor(base.y))) {
		return { x: clamp(base.x, 0.2, MAP_SIZE - 0.2), y: clamp(base.y, 0.2, MAP_SIZE - 0.2) };
	}
	for (let radius = 1; radius <= 12; radius += 1) {
		for (let dy = -radius; dy <= radius; dy += 1) {
			for (let dx = -radius; dx <= radius; dx += 1) {
				if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
				const x = Math.floor(origin.x + dx);
				const y = Math.floor(origin.y + dy);
				if (isWalkable(world, x, y)) return { x: x + 0.5, y: y + 0.5 };
			}
		}
	}
	return { x: clamp(origin.x, 0.2, MAP_SIZE - 0.2), y: clamp(origin.y, 0.2, MAP_SIZE - 0.2) };
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
	if (hasAdminViewer(world)) updateServerTps(world, tickStartedAt);
	try {
		world.tick += 1;
		rebuildOccupancy(world);
		const context = createSimulationContext(world);
		stepSpawner(context, zombieSpawnPolicy, dt);
		stepZombieDirector(world, dt);
		stepActionNoises(world, dt);
		stepResourceDecay(world, dt);
		stepRuinDecay(world, dt);
		for (const unit of Object.values(world.units)) unitBehavior(unit).step(context, unit, dt);
		resolveUnitSeparation(world);
		for (const building of Object.values(world.buildings)) stepBuilding(world, building, dt);
		for (const playerId of Object.keys(world.players)) recalcPlayer(world, playerId);
		updateLeaderboard(world);
	} finally {
		if (hasAdminViewer(world)) updateServerTickDuration(world, performance.now() - tickStartedAt);
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
	world.serverPerf.samples.push({
		tick: world.tick,
		tps: world.serverPerf.tps,
		tickMs: world.serverPerf.tickMs,
		at: Date.now(),
	});
	if (world.serverPerf.samples.length > SERVER_PERF_SAMPLE_LIMIT) {
		world.serverPerf.samples.splice(0, world.serverPerf.samples.length - SERVER_PERF_SAMPLE_LIMIT);
	}
}

function hasAdminViewer(world: World) {
	return Object.values(world.players).some((player) => player.adminLevel);
}

function smoothMetric(current: number, next: number) {
	if (current <= 0) return next;
	return current * (1 - SERVER_PERF_SMOOTHING) + next * SERVER_PERF_SMOOTHING;
}

function createSimulationContext(world: World): UnitSimulationContext & import("./zombieSpawning.js").ZombieSpawnContext {
	const unitGridsByOwner = unitTargetGridsByOwner(world);
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
		moveZombieWithPath: (unit, target, maxStep) => moveZombieWithPath(world, unit, target, maxStep),
		moveZombieSteered: (unit, target, maxStep) => moveZombieSteered(world, unit, target, maxStep),
		moveAroundSmallObstacle: (unit, target, maxStep) => moveAroundSmallObstacle(world, unit, target, maxStep),
		centerOf,
		distance,
		nearestEnemy: (source, range) => nearestEnemy(world, unitGridsByOwner, source, range),
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
		gatherRange: (entity) => (isBuilding(entity) ? entity.gatherRange : 1.1),
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
		unitVision: (unit) => unit.vision || unitBehavior(unit).vision || 5,
		randomInt,
	};
}

function rebuildOccupancy(world: World) {
	const size = MAP_SIZE;
	const previous = world._occupancy ? world._occupancy.slice() : null;
	if (!world._occupancy || world._occupancy.length !== size * size) {
		world._occupancy = new Uint8Array(size * size);
	} else {
		world._occupancy.fill(0);
	}
	const grid = world._occupancy;
	for (const resource of Object.values(world.resources)) {
		const x = Math.round(resource.x);
		const y = Math.round(resource.y);
		if (x >= 0 && y >= 0 && x < size && y < size) grid[y * size + x] = 1;
	}
	for (const building of Object.values(world.buildings)) {
		if (!building.walkBlocking) continue;
		for (let dy = 0; dy < building.height; dy += 1) {
			for (let dx = 0; dx < building.width; dx += 1) {
				const x = building.x + dx;
				const y = building.y + dy;
				if (x >= 0 && y >= 0 && x < size && y < size) grid[y * size + x] = 1;
			}
		}
	}
	if (!previous || occupancyChanged(previous, grid)) {
		world._pathing ??= { occupancyVersion: 0, flowFields: new Map(), clearanceFields: new Map(), arrivalGroups: new Map(), pathRequestsThisTick: 0, lastRequestTick: -1 };
		world._pathing.occupancyVersion += 1;
		world._pathing.flowFields.clear();
		world._pathing.clearanceFields.clear();
		world._pathing.arrivalGroups.clear();
	}
}

function occupancyChanged(previous: Uint8Array, next: Uint8Array) {
	if (previous.length !== next.length) return true;
	for (let i = 0; i < previous.length; i += 1) {
		if (previous[i] !== next[i]) return true;
	}
	return false;
}

function occupied(world: World, x: number, y: number): boolean {
	if (!world._occupancy) return false;
	if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE) return true;
	return world._occupancy[y * MAP_SIZE + x] === 1;
}

function seedResources(world: World) {
	const placement = new ResourcePlacementTracker(world);
	seedTrees(world, placement);
	seedResourcePiles(world, placement, "ore", ORE_VEIN_COUNT, () => 5 + Math.floor(Math.random() * 4));
	seedResourcePiles(world, placement, "berry", BERRY_PATCH_COUNT, () => 4 + Math.floor(Math.random() * 4));
}

function seedTrees(world: World, placement: ResourcePlacementTracker) {
	for (let forest = 0, attempt = 0; forest < FOREST_COUNT && attempt < FOREST_COUNT * RESOURCE_CLUSTER_SEED_ATTEMPT_MULTIPLIER; attempt += 1) {
		if (seedForest(world, placement, randomResourcePoint())) forest += 1;
	}
	for (let tree = 0, attempt = 0; tree < LONE_TREE_COUNT && attempt < LONE_TREE_COUNT * RESOURCE_CLUSTER_SEED_ATTEMPT_MULTIPLIER; attempt += 1) {
		const point = randomResourcePoint();
		if (!placement.canPlaceCluster([point])) continue;
		placement.placeCluster("tree", [point]);
		tree += 1;
	}
}

function seedForest(world: World, placement: ResourcePlacementTracker, center: Vec2) {
	const radiusX = FOREST_MIN_RADIUS + Math.floor(Math.random() * FOREST_RADIUS_VARIANCE);
	const radiusY = FOREST_MIN_RADIUS + Math.floor(Math.random() * FOREST_RADIUS_VARIANCE);
	const wobble = Math.random() * Math.PI * 2;
	const pinch = Math.random() * Math.PI * 2;
	const tiles: Vec2[] = [];

	for (let dy = -radiusY; dy <= radiusY; dy += 1) {
		for (let dx = -radiusX; dx <= radiusX; dx += 1) {
			if (!insideForestShape(dx, dy, radiusX, radiusY, wobble, pinch)) continue;
			tiles.push({ x: center.x + dx, y: center.y + dy });
		}
	}
	if (!placement.canPlaceCluster(tiles)) return false;
	placement.placeCluster("tree", tiles);
	return true;
}

function insideForestShape(dx: number, dy: number, radiusX: number, radiusY: number, wobble: number, pinch: number) {
	const angle = Math.atan2(dy, dx);
	const localRadiusX = radiusX * (0.85 + Math.sin(angle * 2 + pinch) * 0.18 + Math.cos(angle * 4 - wobble) * 0.12);
	const localRadiusY = radiusY * (0.85 + Math.cos(angle * 3 - pinch) * 0.16 + Math.sin(angle * 5 + wobble) * 0.1);
	const edge = 0.92 + Math.sin(angle * 3 + wobble) * 0.2 + Math.cos(angle * 7 - pinch) * 0.12;
	const normalized = (dx * dx) / (localRadiusX * localRadiusX) + (dy * dy) / (localRadiusY * localRadiusY);
	return normalized <= edge;
}

function randomResourcePoint(): Vec2 {
	return {
		x: 4 + Math.floor(Math.random() * (MAP_SIZE - 8)),
		y: 4 + Math.floor(Math.random() * (MAP_SIZE - 8)),
	};
}

function seedResourcePiles(world: World, placement: ResourcePlacementTracker, type: "ore" | "berry", count: number, pileSize: () => number) {
	for (let pile = 0, attempt = 0; pile < count && attempt < count * RESOURCE_CLUSTER_SEED_ATTEMPT_MULTIPLIER; attempt += 1) {
		if (seedConnectedResourcePile(placement, type, randomResourcePoint(), pileSize())) pile += 1;
	}
}

function seedConnectedResourcePile(placement: ResourcePlacementTracker, type: "ore" | "berry", center: Vec2, count: number) {
	const placed: Vec2[] = [];
	if (!placement.canPlaceCluster([center])) return false;
	placed.push(center);

	for (let attempt = 0; placed.length < count && attempt < RESOURCE_PILE_PLACEMENT_ATTEMPTS; attempt += 1) {
		const source = placed[Math.floor(Math.random() * placed.length)]!;
		const neighbor = randomCardinalNeighbor(source);
		if (placed.some((tile) => sameTile(tile, neighbor))) continue;
		if (!placement.canPlaceCluster([neighbor])) continue;
		placed.push(neighbor);
	}
	placement.placeCluster(type, placed);
	return true;
}

function sameTile(a: Vec2, b: Vec2) {
	return Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y);
}

function randomCardinalNeighbor(point: Vec2): Vec2 {
	const neighbors = [
		{ x: point.x + 1, y: point.y },
		{ x: point.x - 1, y: point.y },
		{ x: point.x, y: point.y + 1 },
		{ x: point.x, y: point.y - 1 },
	];
	return neighbors[Math.floor(Math.random() * neighbors.length)]!;
}

class ResourcePlacementTracker {
	private readonly occupied = new Set<string>();

	constructor(private readonly world: World) {
		for (const resource of Object.values(world.resources)) this.mark(resource);
	}

	canPlaceCluster(tiles: Vec2[]) {
		return tiles.every((tile) => this.canPlaceTile(tile));
	}

	placeCluster(type: "tree" | "ore" | "berry", tiles: Vec2[]) {
		for (const tile of tiles) {
			const resource = createSeedResource(this.world, type, tile.x, tile.y);
			if (resource) this.mark(resource);
		}
	}

	private canPlaceTile(point: Vec2) {
		const x = Math.round(point.x);
		const y = Math.round(point.y);
		if (x < 1 || y < 1 || x > MAP_SIZE - 2 || y > MAP_SIZE - 2) return false;
		for (let dy = -RESOURCE_CLUSTER_GAP; dy <= RESOURCE_CLUSTER_GAP; dy += 1) {
			for (let dx = -RESOURCE_CLUSTER_GAP; dx <= RESOURCE_CLUSTER_GAP; dx += 1) {
				if (this.occupied.has(this.key(x + dx, y + dy))) return false;
			}
		}
		return true;
	}

	private mark(point: Vec2) {
		this.occupied.add(this.key(Math.round(point.x), Math.round(point.y)));
	}

	private key(x: number, y: number) {
		return `${x},${y}`;
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
	const existingTownCenters = Object.values(world.buildings).filter((building) => building.type === "townCenter");
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
	const size = BUILDING_TYPES.townCenter.size;
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
		hp: def.maxHp,
		maxHp: def.maxHp,
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
	const def = BUILDING_TYPES[type];
	const building = createBuildingInstance(type, { id: id("b"), ownerId, x, y });
	if (!free && !spend(world.players[ownerId]!, def.cost)) return null;
	world.buildings[building.id] = building;
	return building;
}

function createResource(world: World, type: keyof typeof RESOURCE_DEFS, x: number, y: number): ResourceNode | null {
	x = clamp(Math.round(x), 1, MAP_SIZE - 2);
	y = clamp(Math.round(y), 1, MAP_SIZE - 2);
	const blocked = [...Object.values(world.resources), ...Object.values(world.buildings)].some((entity) => pointInsideEntity(x, y, entity));
	if (blocked) return null;
	return addResourceNode(world, type, x, y);
}

function createSeedResource(world: World, type: keyof typeof RESOURCE_DEFS, x: number, y: number): ResourceNode {
	return addResourceNode(world, type, clamp(Math.round(x), 1, MAP_SIZE - 2), clamp(Math.round(y), 1, MAP_SIZE - 2));
}

function addResourceNode(world: World, type: keyof typeof RESOURCE_DEFS, x: number, y: number): ResourceNode {
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
		width: building.width,
		height: building.height,
		age: 0,
	};
}

function pointInsideEntity(x: number, y: number, entity: Footprint): boolean {
	return x >= Math.floor(entity.x) && x < Math.floor(entity.x) + footprintWidth(entity) && y >= Math.floor(entity.y) && y < Math.floor(entity.y) + footprintHeight(entity);
}

function commandMove(world: World, playerId: PlayerId, body: Extract<CommandPayload, { type: "move" }>): CommandResult {
	const clusterLandingTargets = new WeakMap<Unit[], { x: number; y: number }>();
	forOwnUnitClusters(world, playerId, body.unitIds, (unit, cluster, index, reservedFormationTargets) => {
		const target = {
			x: clamp(Number(body.x), 0, MAP_SIZE - 1),
			y: clamp(Number(body.y), 0, MAP_SIZE - 1),
		};
		let landingTarget = clusterLandingTargets.get(cluster);
		if (!landingTarget) {
			landingTarget = nearestWalkablePoint(world, target, reservedFormationTargets);
			clusterLandingTargets.set(cluster, landingTarget);
		}
		const formationTarget = formationTargetForCluster(world, landingTarget, cluster, index, reservedFormationTargets);
		unit.command = formationTarget ? moveFormationCommand(target, cluster.length, formationTarget) : {
			type: "move",
			...target,
			path: null,
			pathCrowd: cluster.length,
		};
	});
	return { ok: true };
}

function moveFormationCommand(target: { x: number; y: number }, crowd: number, formationTarget: { x: number; y: number }) {
	return {
		type: "move" as const,
		...target,
		path: null,
		pathCrowd: crowd,
		formationTarget,
	};
}

function commandAttack(world: World, playerId: PlayerId, body: Extract<CommandPayload, { type: "attack" }>): CommandResult {
	const target = world.units[body.targetId] || world.buildings[body.targetId];
	if (!target || target.ownerId === playerId) return { ok: false, error: "Invalid target." };
	let assigned = false;
	forOwnUnitClusters(world, playerId, body.unitIds, (unit, cluster) => {
		unit.command = { type: "attack", targetId: target.id, path: null, pathCrowd: cluster.length };
		assigned = true;
	});
	return assigned ? { ok: true } : { ok: false, error: "Select units to command." };
}

function commandGather(world: World, playerId: PlayerId, body: Extract<CommandPayload, { type: "gather" }>): CommandResult {
	const targetBuilding = world.buildings[body.targetId];
	const depotResource = targetBuilding?.ownerId === playerId && isComplete(targetBuilding) ? targetBuilding.depotGatherKind() : null;
	const depotGatherTarget = targetBuilding && depotResource ? findNextResourceNear(world, centerOf(targetBuilding), depotResource, playerId) : null;
	const resource = world.resources[body.targetId] || gatherableBuilding(targetBuilding, playerId) || depotGatherTarget;
	if (!resource) return { ok: false, error: "Invalid resource." };
	let assigned = false;
	forOwnUnits(world, playerId, body.unitIds, (unit) => {
		if (unitBehavior(unit).canGather) {
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
	const def = BUILDING_TYPES[body.buildingType];
	if (!def) return { ok: false, error: "Unknown building." };
	const footprint = {
		width: ("width" in def ? def.width : def.size) as number,
		height: ("height" in def ? def.height : def.size) as number,
	};
	const x = clamp(Math.round(Number(body.x)), 0, MAP_SIZE - footprint.width);
	const y = clamp(Math.round(Number(body.y)), 0, MAP_SIZE - footprint.height);
	const replacementWall = ownWallAt(world, playerId, x, y);
	if (body.buildingType === "wall" && replacementWall) return { ok: true };
	if (!canPlace(world, x, y, footprint.width, footprint.height, replacementWall)) return { ok: false, error: "Blocked tile." };
	const builders = Object.values(world.units).filter(
		(unit) => unit.ownerId === playerId && body.unitIds?.includes(unit.id) && unitBehavior(unit).canBuild,
	);
	if (builders.length === 0) return { ok: false, error: "Select build-capable units." };
	if (body.buildingType === "gate" && replacementWall) return replaceWallWithGate(world, playerId, replacementWall, builders);
	const building = createBuilding(world, playerId, body.buildingType, x, y);
	if (!building) return { ok: false, error: "Not enough resources." };
	building.startConstruction(Math.max(12, Math.floor(building.maxHp * 0.25)));
	building.builderIds = builders.map((unit) => unit.id);
	const resourceKind = building.depotGatherKind();
	for (const unit of builders) unit.command = { type: "build", targetId: building.id, path: null, resourceKind, gatherBuiltFarm: building.shouldGatherAfterBuild };
	return { ok: true };
}

function replaceWallWithGate(world: World, playerId: PlayerId, wall: Building, builders: Unit[]): CommandResult {
	const player = world.players[playerId];
	if (!player) return { ok: false, error: "Player not found." };
	const refund = wall.isComplete() ? {} : wall.cost;
	const cost = netCost(BUILDING_TYPES.gate.cost, refund);
	if (!spend(player, cost)) return { ok: false, error: "Not enough resources." };
	delete world.buildings[wall.id];
	const gate = createBuilding(world, playerId, "gate", wall.x, wall.y, true);
	if (!gate) return { ok: false, error: "Could not place gate." };
	gate.startConstruction(Math.max(12, Math.floor(gate.maxHp * 0.25)));
	gate.builderIds = builders.map((unit) => unit.id);
	for (const unit of builders) unit.command = { type: "build", targetId: gate.id, path: null, resourceKind: null, gatherBuiltFarm: false };
	return { ok: true };
}

function ownWallAt(world: World, playerId: PlayerId, x: number, y: number) {
	return Object.values(world.buildings).find((building) => (
		building.ownerId === playerId &&
		building.type === "wall" &&
		building.x === x &&
		building.y === y
	)) || null;
}

function commandFinishBuild(world: World, playerId: PlayerId, body: Extract<CommandPayload, { type: "finishBuild" }>): CommandResult {
	const building = world.buildings[body.buildingId];
	if (!building || building.ownerId !== playerId) return { ok: false, error: "Invalid building." };
	if (isComplete(building) && building.hp >= building.maxHp) return { ok: false, error: "Building is already fully repaired." };
	const builders = Object.values(world.units).filter(
		(unit) => unit.ownerId === playerId && body.unitIds?.includes(unit.id) && unitBehavior(unit).canBuild,
	);
	if (builders.length === 0) return { ok: false, error: "Select build-capable units." };
	if (isComplete(building)) {
		const player = world.players[playerId];
		if (!player) return { ok: false, error: "Player not found." };
		const cost = repairCost(building);
		if (!spend(player, cost)) return { ok: false, error: "Not enough resources to repair." };
		building.repairPaidUntilHp = building.maxHp;
	}
	const resourceKind = building.depotGatherKind();
	building.builderIds = [...new Set([...(building.builderIds || []), ...builders.map((unit) => unit.id)])];
	for (const unit of builders) unit.command = { type: "build", targetId: building.id, path: null, resourceKind, gatherBuiltFarm: building.shouldGatherAfterBuild };
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
	const target = body.targetId ? world.buildings[body.targetId as BuildingId] : null;
	building.rallyPoint = target ? centerOf(target) : {
		x: clamp(Number(body.x), 0, MAP_SIZE - 1),
		y: clamp(Number(body.y), 0, MAP_SIZE - 1),
	};
	building.rallyTargetId = target?.id ?? null;
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
	if (!building.queue) return { ok: false, error: "Selected building cannot train units." };
	if (building.queue.length >= 10) return { ok: false, error: "Training queue is full." };
	if (!spend(player, unitDef.cost)) return { ok: false, error: "Not enough resources." };
	building.queue.push({ unitType: body.unitType, remaining: unitDef.trainTime } as BuildQueueItem);
	return { ok: true };
}

function forOwnUnits(world: World, playerId: PlayerId, unitIds: UnitId[] | undefined, fn: (unit: Unit, index: number) => void) {
	if (!Array.isArray(unitIds)) return;
	unitIds.forEach((unitId, index) => {
		const unit = world.units[unitId];
		if (unit?.ownerId === playerId) fn(unit, index);
	});
}

function forOwnUnitClusters(world: World, playerId: PlayerId, unitIds: UnitId[] | undefined, fn: (unit: Unit, cluster: Unit[], index: number, reservedFormationTargets: Set<string>) => void) {
	const units = ownUnits(world, playerId, unitIds);
	for (const cluster of spatialUnitClusters(units)) {
		const ordered = orderFormationCluster(cluster);
		const reservedFormationTargets = new Set<string>();
		ordered.forEach((unit, index) => fn(unit, ordered, index, reservedFormationTargets));
	}
}

function orderFormationCluster(cluster: Unit[]): Unit[] {
	const center = clusterCenter(cluster);
	return [...cluster].sort((a, b) => {
		const ay = a.y - center.y;
		const by = b.y - center.y;
		if (Math.abs(ay - by) > 0.001) return ay - by;
		return (a.x - center.x) - (b.x - center.x);
	});
}

function clusterCenter(cluster: Unit[]) {
	const total = cluster.reduce((sum, unit) => ({ x: sum.x + unit.x, y: sum.y + unit.y }), { x: 0, y: 0 });
	return { x: total.x / Math.max(1, cluster.length), y: total.y / Math.max(1, cluster.length) };
}

function formationTargetForCluster(world: World, target: { x: number; y: number }, cluster: Unit[], index: number, reserved: Set<string>) {
	const offset = formationSlotOffset(cluster.length, index);
	if (!offset) return undefined;
	return nearestWalkablePoint(world, { x: target.x + offset.x, y: target.y + offset.y }, reserved);
}

function formationSlotOffset(count: number, index: number) {
	if (count < 2 || index === 0) return undefined;
	const spacing = formationSpacing(count);
	const angle = index * 2.399963229728653;
	const radius = spacing * Math.sqrt(index);
	const x = Math.cos(angle) * radius;
	const y = Math.sin(angle) * radius;
	return isFinite(x) && isFinite(y) ? { x, y } : undefined;
}

function formationSpacing(count: number) {
	if (count >= 500) return 0.86;
	if (count >= 220) return 0.82;
	if (count >= 120) return 0.76;
	if (count >= 40) return 0.7;
	if (count >= 12) return 0.64;
	return 0.6;
}

function nearestWalkablePoint(world: World, point: { x: number; y: number }, reserved?: Set<string>) {
	const origin = {
		x: clamp(Math.floor(point.x), 0, MAP_SIZE - 1),
		y: clamp(Math.floor(point.y), 0, MAP_SIZE - 1),
	};
	if (isAvailableFormationTile(world, origin.x, origin.y, reserved)) return reserveFormationPoint(origin.x, origin.y, reserved);
	for (let radius = 1; radius <= 16; radius += 1) {
		for (let y = origin.y - radius; y <= origin.y + radius; y += 1) {
			for (let x = origin.x - radius; x <= origin.x + radius; x += 1) {
				if (Math.abs(x - origin.x) !== radius && Math.abs(y - origin.y) !== radius) continue;
				if (isAvailableFormationTile(world, x, y, reserved)) return reserveFormationPoint(x, y, reserved);
			}
		}
	}
	return { x: clamp(point.x, 0.2, MAP_SIZE - 0.2), y: clamp(point.y, 0.2, MAP_SIZE - 0.2) };
}

function isAvailableFormationTile(world: World, x: number, y: number, reserved?: Set<string>) {
	return isWalkable(world, x, y) && !reserved?.has(`${x},${y}`);
}

function reserveFormationPoint(x: number, y: number, reserved?: Set<string>) {
	reserved?.add(`${x},${y}`);
	return { x: x + 0.5, y: y + 0.5 };
}

function ownUnits(world: World, playerId: PlayerId, unitIds: UnitId[] | undefined): Unit[] {
	if (!Array.isArray(unitIds)) return [];
	return unitIds
		.map((unitId) => world.units[unitId])
		.filter((unit): unit is Unit => unit?.ownerId === playerId);
}

function spatialUnitClusters(units: Unit[]): Unit[][] {
	const remaining = new Set(units);
	const clusters: Unit[][] = [];
	for (const seed of units) {
		if (!remaining.has(seed)) continue;
		const cluster = [];
		const queue = [seed];
		remaining.delete(seed);
		for (let index = 0; index < queue.length; index += 1) {
			const unit = queue[index]!;
			cluster.push(unit);
			for (const other of remaining) {
				if (distance(unit, other) > COMMAND_CLUSTER_DISTANCE) continue;
				remaining.delete(other);
				queue.push(other);
			}
		}
		clusters.push(cluster);
	}
	return clusters;
}

function stepBuilding(world: World, building: Building, dt: number) {
	if (building.cooldown !== undefined) building.cooldown = Math.max(0, building.cooldown - dt);
	if (building.attackFlash !== undefined) building.attackFlash = Math.max(0, (building.attackFlash || 0) - dt);
	if (!isComplete(building)) return;
	if (building.queue && building.queue.length > 0) {
		const current = building.queue[0];
		if (current) current.remaining -= dt;
		emitActionSound(world, "trainUnit", centerOf(building));
		if (current && current.remaining <= 0) {
			const item = building.queue.shift();
			if (!item) return;
			const unit = createUnit(world, building.ownerId, item.unitType, building.x + building.width + 0.4, building.y + building.height + 0.2);
			if (building.rallyPoint) {
				assignRallyCommand(world, unit, building.rallyPoint, building.rallyTargetId ?? null);
			}
		}
	}
	if (building.canAttack) {
		const target = nearestEnemy(world, unitTargetGridsByOwner(world), building, building.attackRange);
		if (target && (building.cooldown ?? 0) <= 0) {
			damage(world, target, building.attack, building.ownerId);
			emitActionSound(world, "towerAttack", centerOf(building));
			building.cooldown = building.attackCooldown;
			building.attackFlash = 0.22;
		}
	}
}

function attackBlockingBuilding(world: World, zombie: Unit, targetPoint: { x: number; y: number }) {
	const behavior = unitBehavior(zombie);
	const building = blockingBuildingToward(world, zombie, targetPoint);
	if (!building || zombie.cooldown > 0) return;
	damage(world, building, behavior.attack, ZOMBIE_OWNER_ID);
	zombie.cooldown = behavior.cooldown;
	zombie.attackFlash = 0.22;
}

function blockingBuildingToward(world: World, zombie: Unit, targetPoint: { x: number; y: number }): Building | null {
	const dx = targetPoint.x - zombie.x;
	const dy = targetPoint.y - zombie.y;
	const length = Math.hypot(dx, dy) || 1;
	const x = zombie.x + (dx / length) * 0.65;
	const y = zombie.y + (dy / length) * 0.65;
	return Object.values(world.buildings).find((building) => pointInsideEntity(Math.round(x), Math.round(y), building)) || null;
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
	const sources = buildSoundField(collectWorldSoundSources(world, ZOMBIE_OWNER_ID)).map((cell) => ({ point: { x: cell.x, y: cell.y }, strength: cell.strength }));
	let total = 0;
	for (const source of sources) total += source.strength;
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
	if (builtFarm && unitBehavior(unit).canGather && isComplete(builtFarm)) {
		const resource = builtFarm.gatherResource;
		if (resource) {
			unit.command = { type: "gather", targetId: builtFarm.id, resourceKind: resource, progress: 0, path: null };
			return;
		}
	}
	if (resourceKind && unitBehavior(unit).canGather) {
		const next = findNextResource(world, unit, resourceKind);
		if (next) {
			unit.command = { type: "gather", targetId: next.id, resourceKind, progress: 0, path: null };
			return;
		}
	}
	const nextBuild = findNextBuildSite(world, unit);
	if (!nextBuild) {
		unit.command = { type: "idle" };
		return;
	}
	nextBuild.builderIds = [...new Set([...(nextBuild.builderIds || []), unit.id])];
	unit.command = { type: "build", targetId: nextBuild.id, path: null, resourceKind: nextBuild.depotGatherKind(), gatherBuiltFarm: nextBuild.shouldGatherAfterBuild };
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
	return findNextResourceNear(world, unit, resourceKind, unit.ownerId);
}

function findNextResourceNear(world: World, source: { x: number; y: number }, resourceKind: ResourceType | null, playerId: PlayerId): ResourceNode | Building | null {
	if (!resourceKind) return null;
	const RANGE = 30;
	let best = null;
	let bestDist = RANGE;
	for (const r of Object.values(world.resources)) {
		if (r.amount <= 0 || r.resource !== resourceKind) continue;
		const d = distance(source, r);
		if (d < bestDist) {
			best = r;
			bestDist = d;
		}
	}
	for (const b of Object.values(world.buildings)) {
		if (!b.canBeGatheredBy(playerId) || b.gatherResource !== resourceKind || b.gatherExhausted) continue;
		const d = distance(source, centerOf(b));
		if (d < bestDist) {
			best = b;
			bestDist = d;
		}
	}
	return best;
}

function assignRallyCommand(world: World, unit: Unit, rallyPoint: Vec2, targetId: EntityId | null) {
	const target = targetId ? world.buildings[targetId as BuildingId] : null;
	if (target && assignRallyTargetCommand(world, unit, target)) return;
	const depot = depotAtPoint(world, unit.ownerId, rallyPoint);
	const resourceKind = depot?.depotGatherKind() || depot?.gatherResource || null;
	if (resourceKind && unitBehavior(unit).canGather) {
		const resource = findNextResourceNear(world, depot ? centerOf(depot) : rallyPoint, resourceKind, unit.ownerId);
		if (resource) {
			unit.command = { type: "gather", targetId: resource.id, resourceKind, progress: 0, path: null };
			return;
		}
	}
	unit.command = { type: "move", ...rallyPoint, path: null };
}

function assignRallyTargetCommand(world: World, unit: Unit, target: Building) {
	if (target.ownerId === unit.ownerId && target.hp < target.maxHp && unitBehavior(unit).canBuild) {
		if (isComplete(target)) {
			const player = world.players[unit.ownerId];
			if (player && spend(player, repairCost(target))) target.repairPaidUntilHp = target.maxHp;
				else return false;
		}
		target.builderIds = [...new Set([...(target.builderIds || []), unit.id])];
		unit.command = { type: "build", targetId: target.id, path: null, resourceKind: target.depotGatherKind(), gatherBuiltFarm: target.shouldGatherAfterBuild };
		return true;
	}
	const resourceKind = target.depotGatherKind() || target.gatherResource;
	if (target.ownerId === unit.ownerId && resourceKind && unitBehavior(unit).canGather) {
		const resource = target.depotGatherKind()
			? findNextResourceNear(world, centerOf(target), resourceKind, unit.ownerId)
			: target.canBeGatheredBy(unit.ownerId) && !target.gatherExhausted ? target : null;
		if (resource) {
			unit.command = { type: "gather", targetId: resource.id, resourceKind, progress: 0, path: null };
			return true;
		}
	}
	unit.command = { type: "move", ...centerOf(target), path: null };
	return true;
}

function depotAtPoint(world: World, playerId: PlayerId, point: Vec2): Building | null {
	return Object.values(world.buildings).find((building) => (
		building.ownerId === playerId &&
		isComplete(building) &&
		(building.depotGatherKind() || building.gatherResource) &&
		pointInsideEntity(Math.floor(point.x), Math.floor(point.y), building)
	)) || null;
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

function unitTargetGridsByOwner(world: World): Map<PlayerId, SpatialGrid<Unit>> {
	const unitsByOwner = new Map<PlayerId, Unit[]>();
	for (const unit of Object.values(world.units)) {
		if (unit.hp <= 0) continue;
		const units = unitsByOwner.get(unit.ownerId);
		if (units) units.push(unit);
			else unitsByOwner.set(unit.ownerId, [unit]);
	}
	return new Map([...unitsByOwner.entries()].map(([ownerId, units]) => [ownerId, new SpatialGrid(units, TARGET_UNIT_GRID_CELL_SIZE)]));
}

function nearestEnemy(world: World, unitGridsByOwner: Map<PlayerId, SpatialGrid<Unit>>, source: Unit | Building, range: number) {
	let best = null;
	let bestDist = range;
	const sourceCenter = centerOf(source);
	for (const [ownerId, unitGrid] of unitGridsByOwner) {
		if (ownerId === source.ownerId) continue;
		for (const entry of unitGrid.nearby(sourceCenter, range, 24)) {
			const unit = entry.item;
			if (unit.hp <= 0 || world.units[unit.id] !== unit) continue;
			const d = distance(sourceCenter, unit);
			if (d < bestDist) {
				best = unit;
				bestDist = d;
			}
		}
	}
	for (const building of Object.values(world.buildings)) {
		if (building.ownerId === source.ownerId || building.hp <= 0) continue;
		const d = distance(sourceCenter, centerOf(building));
		if (d < bestDist) {
			best = building;
			bestDist = d;
		}
	}
	return best;
}

function isBuilding(entity: ResourceNode | Building | null | undefined): entity is Building {
	return entity?.kind === "building";
}

function gatherResource(entity: ResourceNode | Building): ResourceType {
	if (isBuilding(entity)) return entity.gatherResource!;
	return entity.resource;
}

function gatherTargetFor(entity: ResourceNode | Building): GatherTarget {
	if (isBuilding(entity)) return entity;
	return {
		gatherAmountFor: (unit) => unit.carryCapacity,
		gatherSecondsFor: () => 20,
	};
}

function damage(world: World, target: Unit | Building, amount: number, attackerId: PlayerId) {
	if (target.kind === "building" && target.invincible) return;
	target.hp -= amount;
	if (target.kind === "building" && target.repairPaidUntilHp !== undefined) {
		target.repairPaidUntilHp = Math.min(target.repairPaidUntilHp, target.hp);
	}
	if (target.hp > 0) return;
	if (target.kind === "building") {
		emitActionSound(world, "buildingDestroyed", centerOf(target));
		createRuin(world, target);
		delete world.buildings[target.id];
		if (target.type === "townCenter") defeatPlayer(world, target.ownerId, attackerId);
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

function canPlace(world: World, x: number, y: number, width: number, height: number, ignoredBuilding: Building | null = null): boolean {
	if (x < 0 || y < 0 || x + width > MAP_SIZE || y + height > MAP_SIZE) return false;
	for (const building of Object.values(world.buildings)) {
		if (building === ignoredBuilding) continue;
		if (rectsOverlap({ x, y, width, height }, building)) return false;
	}
	for (let dy = 0; dy < height; dy += 1) {
		for (let dx = 0; dx < width; dx += 1) {
			if (ignoredBuilding && pointInsideEntity(x + dx, y + dy, ignoredBuilding)) continue;
			if (occupied(world, x + dx, y + dy)) return false;
		}
	}
	return true;
}

function centerOf(entity: Footprint) {
	return { x: entity.x + (footprintWidth(entity) - 1) / 2, y: entity.y + (footprintHeight(entity) - 1) / 2 };
}

function spend(player: Player, cost: Partial<Record<ResourceType, number>> = {}): boolean {
	const entries = Object.entries(cost) as [ResourceType, number][];
	for (const [resource, amount] of entries) {
		if ((player.resources[resource] || 0) < amount) return false;
	}
	for (const [resource, amount] of entries) player.resources[resource] -= amount;
	return true;
}

function netCost(cost: Partial<Record<ResourceType, number>>, refund: Partial<Record<ResourceType, number>>) {
	const result: Partial<Record<ResourceType, number>> = { ...cost };
	for (const [resource, amount] of Object.entries(refund) as [ResourceType, number][]) {
		result[resource] = Math.max(0, (result[resource] || 0) - amount);
	}
	return result;
}

function repairCost(building: Building) {
	const paidUntilHp = building.repairPaidUntilHp ?? building.hp;
	const missingHealthRatio = Math.max(0, building.maxHp - Math.max(building.hp, paidUntilHp)) / building.maxHp;
	return Object.fromEntries(
		Object.entries(building.cost).map(([resource, amount]) => [resource, Math.ceil(amount * missingHealthRatio)]),
	) as Partial<Record<ResourceType, number>>;
}

function recalcPlayer(world: World, playerId: PlayerId) {
	const player = world.players[playerId];
	if (!player) return;
	const units = Object.values(world.units).filter((unit) => unit.ownerId === playerId);
	const buildings = Object.values(world.buildings).filter((building) => building.ownerId === playerId);
	player.population = units.length;
	player.popCap = 4 + buildings.filter(isComplete).reduce((sum, building) => {
		return sum + building.populationCapacity;
	}, 0);
	const unitScore = units.reduce((sum, unit) => sum + unitBehavior(unit).score, 0);
	const buildingScore = buildings.filter(isComplete).reduce((sum, building) => sum + building.score, 0);
	player.score = player.defeated ? 0 : unitScore + buildingScore;
}

function isComplete(building: Building): boolean {
	return building.isComplete();
}

function updateLeaderboard(world: World) {
	const leaders = Object.values(world.players)
		.filter((player) => !player.defeated)
		.sort((a, b) => b.score - a.score);
	const leader = leaders[0] ?? null;
	if (!leader) {
		delete world.firstPlacePlayerId;
		delete world.firstPlaceSince;
		world.leaderboard = [];
		return;
	}
	if (world.firstPlacePlayerId !== leader.id) {
		world.firstPlacePlayerId = leader.id;
		world.firstPlaceSince = Date.now();
	}
	world.leaderboard = leaders.map((player) => ({
		id: player.id,
		name: player.name,
		color: player.color,
		score: player.score,
		defeated: player.defeated,
		joinedAt: player.joinedAt,
		firstPlaceSince: player.id === world.firstPlacePlayerId ? world.firstPlaceSince ?? null : null,
	}));
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
