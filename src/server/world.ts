import {
	ACTION_SOUND_DEFS,
	COLORS,
	MAP_SIZE,
	RESOURCE_DEFS,
	RESOURCE_TYPES,
	STARTING_RESOURCES,
	STARTING_UNITS,
	TICK_RATE,
} from "../shared/config.js";
import {
	BUILDING_TYPES,
	createBuilding as createBuildingInstance,
} from "../shared/buildings/index.js";
import {
	buildSoundField,
	collectWorldSoundSources,
} from "../shared/soundField.js";
import { unitBehaviorFor } from "../shared/unitRegistry.js";
import type { UnitSimulationContext } from "../shared/units/index.js";
import type { GatherTarget } from "../shared/buildings/base/index.js";
import { id } from "./id.js";
import {
	clamp,
	distance,
	footprintHeight,
	footprintWidth,
	rectsOverlap,
	type Footprint,
} from "./math.js";
import {
	hasPathToInteractionRange,
	hasReasonableZombiePathToTarget,
	isWalkable,
	moveAroundSmallObstacle,
	moveUnit,
	moveZombieSteered,
	moveZombieWithPath,
	resolveUnitSeparation,
} from "./pathing.js";
import { PlayerUnitPathfinder } from "./playerUnitPathing.js";
import { stepSpawner } from "./spawning.js";
import { SpatialGrid } from "./utils/SpatialGrid.js";
import type {
	ZombieAiAttackIntent,
	ZombieAiStep,
} from "./zombieAiWorkerProtocol.js";
import { stepZombieDirector } from "./zombieDirector.js";
import { ZOMBIE_OWNER_ID, zombieSpawnPolicy } from "./zombieSpawning.js";
import { Logs } from "../shared/logs.js";
import { DAY_NIGHT_CYCLE_SECONDS } from "../shared/dayNight.js";
import { PlayerStatistics } from "./PlayerStatistics.js";
import type {
	BuildQueueItem,
	Building,
	BuildingId,
	BuildingType,
	CommandPayload,
	CommandResult,
	Corpse,
	EntityId,
	Player,
	PlayerId,
	ResourceCost,
	ResourceNode,
	ResourceType,
	Ruin,
	Unit,
	UnitCommand,
	UnitId,
	UnitType,
	Vec2,
	World,
} from "../shared/types.js";
import type {
	ServerPerfPhase,
	ServerPerfUnitAiStats,
	ServerPerfZombieStats,
} from "../shared/types.js";

const PLAYER_SPAWN_MARGIN = 34;
const MIN_PLAYER_SPAWN_DISTANCE = 54;
const PLAYER_SPAWN_ATTEMPTS = 220;
const PLAYER_SPAWN_RESOURCE_CLEAR_RADIUS = 14;
const PLAYER_SPAWN_ZOMBIE_CLEAR_RADIUS = PLAYER_SPAWN_RESOURCE_CLEAR_RADIUS * 2;
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
const RALLY_GATHER_RADIUS = 6;
const GATHER_RETARGET_CANDIDATE_LIMIT = 20;
const GATHER_ASSIGNMENT_SPREAD_PENALTY = 1000;
const RESOURCE_GATHER_RANGE = 1.1;
const FORMATION_SEARCH_RADIUS = 16;
const FORMATION_ADJACENT_BLOCK_PENALTY = 5;
const FORMATION_NEARBY_BLOCK_PENALTY = 1.2;
function createEmptyWorkerCounts() {
	return {
		idle: 0,
		gathering: Object.fromEntries(
			RESOURCE_TYPES.map((resource) => [resource, 0]),
		) as Record<ResourceType, number>,
	};
}
const FOREST_COUNT = 71;
const LONE_TREE_COUNT = 269;
const FOREST_MIN_RADIUS = 4;
const FOREST_RADIUS_VARIANCE = 12;
const ORE_VEIN_COUNT = 86;
const BERRY_PATCH_COUNT = 62;
const RESOURCE_PILE_PLACEMENT_ATTEMPTS = 80;
const RESOURCE_CLUSTER_GAP = 2;
const RESOURCE_CLUSTER_SEED_ATTEMPT_MULTIPLIER = 8;
const INITIAL_TIME_OF_DAY_PROGRESS = 9 / 24;
const ZOMBIE_NEAR_VISION_DISTANCE = 34;
const ZOMBIE_MID_VISION_DISTANCE = 72;
const ZOMBIE_NEAR_CADENCE_TICKS = 1;
const ZOMBIE_MID_CADENCE_TICKS = 3;
const ZOMBIE_FAR_CADENCE_TICKS = 8;
const ZOMBIE_CADENCE_FIELD_CELL_SIZE = 4;
const ZOMBIE_CADENCE_FIELD_REBUILD_TICKS = 4;
export type ZombieAiService = {
	step(
		world: World,
		dt: number,
		zombies: ZombieAiStep[],
		applyAttack: (attack: ZombieAiAttackIntent) => void,
		profiler: ZombieAiStepProfiler | null,
	): boolean;
};

export type ZombieAiStepProfiler = {
	measure<T>(name: string, label: string, count: number, work: () => T): T;
};

export type ZombieDirectorService = {
	step(world: World, dt: number): void;
};

export type SimulationServices = {
	zombieAi: ZombieAiService;
	zombieDirector: ZombieDirectorService;
};

const directZombieAi: ZombieAiService = {
	step() {
		return false;
	},
};

const directZombieDirector: ZombieDirectorService = {
	step(world, dt) {
		stepZombieDirector(world, dt);
		world._zombieWorkerPerf = {
			enabled: false,
			pending: false,
			lastDurationMs: 0,
			lastCompletedTick: world.tick,
			lastAppliedTick: world.tick,
			failures: 0,
			mode: "fallback",
		};
	},
};

let simulationServices: SimulationServices = {
	zombieAi: directZombieAi,
	zombieDirector: directZombieDirector,
};

export function configureSimulationServices(services: Partial<SimulationServices>) {
	simulationServices = { ...simulationServices, ...services };
}

export function createWorld(): World {
	const startedAt = Date.now();
	const world: World = {
		map: { size: MAP_SIZE },
		players: createRecord(),
		units: createRecord(),
		buildings: createRecord(),
		resources: createRecord(),
		ruins: createRecord(),
		corpses: createRecord(),
		notices: [],
		adminLogs: [],
		bannedIpAddresses: [],
		actionNoises: [],
		leaderboard: [],
		startedAt,
		timeOffsetSeconds:
			INITIAL_TIME_OF_DAY_PROGRESS * DAY_NIGHT_CYCLE_SECONDS,
		tick: 0,
		spawnTimers: {},
		serverPerf: { tps: TICK_RATE, tickMs: 0, samples: [] },
	};
	seedResources(world);
	rebuildOccupancy(world);
	return world;
}

function createRecord<T>(): Record<string, T> {
	return Object.create(null) as Record<string, T>;
}

export function shiftWorldTime(world: World, hours: number) {
	world.timeOffsetSeconds = (world.timeOffsetSeconds || 0) + hours * 60 * 60;
	for (const player of Object.values(world.players)) delete player._visCache;
}

export function setWorldTimeOfDay(world: World, progress: number) {
	const targetProgress = ((progress % 1) + 1) % 1;
	const elapsedSeconds =
		(Date.now() - (world.startedAt ?? 0)) / 1000 +
		(world.timeOffsetSeconds || 0);
	const currentProgress =
		(((elapsedSeconds / DAY_NIGHT_CYCLE_SECONDS) % 1) + 1) % 1;
	world.timeOffsetSeconds =
		(world.timeOffsetSeconds || 0) +
		(targetProgress - currentProgress) * DAY_NIGHT_CYCLE_SECONDS;
	for (const player of Object.values(world.players)) delete player._visCache;
}

export function addPlayer(
	world: World,
	name: string,
	requestedColor: string | null = null,
): PlayerId {
	const activeCount = Object.values(world.players).filter(
		(p) => !p.defeated,
	).length;
	const playerId = id("p");
	const spawn = chooseSpawn(world, activeCount);
	const color: string =
		normalizeColor(requestedColor) || COLORS[activeCount % COLORS.length]!;
	world.players[playerId] = {
		id: playerId,
		name: name,
		color,
		resources: { ...STARTING_RESOURCES },
		autoReplenishFarms: true,
		explored: new Set(),
		population: 0,
		popCap: 0,
		workerCounts: createEmptyWorkerCounts(),
		defeated: false,
		score: 0,
		joinedAt: Date.now(),
		statistics: new PlayerStatistics(),
	};

	clearSpawnResources(
		world,
		spawn.x,
		spawn.y,
		PLAYER_SPAWN_RESOURCE_CLEAR_RADIUS,
	);
	clearSpawnZombies(
		world,
		spawn.x,
		spawn.y,
		PLAYER_SPAWN_ZOMBIE_CLEAR_RADIUS,
	);
	createBuilding(world, playerId, "townCenter", spawn.x, spawn.y, true);
	for (const unit of STARTING_UNITS)
		createUnit(
			world,
			playerId,
			unit.unitType,
			spawn.x + unit.x,
			spawn.y + unit.y,
		);
	addLocalResources(world, spawn.x, spawn.y);
	notice(world, `${world.players[playerId]!.name} joined the world.`);
	Logs.log(`${world.players[playerId]!.name} joined the world.`);
	recalcPlayer(world, playerId);
	updateLeaderboard(world);
	return playerId;
}

export function addAdminLog(
	world: World,
	source: string,
	message: string,
	at = Date.now(),
) {
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

function clearSpawnResources(
	world: World,
	x: number,
	y: number,
	radius: number,
) {
	for (const resource of Object.values(world.resources)) {
		if (distance(resource, { x, y }) <= radius) {
			removeResource(world, resource);
		}
	}
}

function clearSpawnZombies(world: World, x: number, y: number, radius: number) {
	for (const unit of Object.values(world.units)) {
		if (unit.ownerId !== ZOMBIE_OWNER_ID) continue;
		if (distance(unit, { x, y }) <= radius) {
			removeUnit(world, unit);
		}
	}
}

export function removePlayer(world: World, playerId: PlayerId) {
	const player = world.players[playerId];
	if (!player) return null;
	player.statistics?.finish();
	const statistics = player.statistics?.snapshot() ?? null;
	notice(world, `${player.name} left the world.`);
	Logs.log(`${player.name} left the world.`);
	destroyPlayerStuff(world, playerId);
	delete world.players[playerId];
	updateLeaderboard(world);
	return statistics;
}

export function spawnZombieHorde(
	world: World,
	playerId: PlayerId,
	count: number,
): number {
	if (!world.players[playerId]) return 0;
	const safeCount = clamp(Math.floor(count), 1, 2000);
	for (let i = 0; i < safeCount; i += 1) {
		const point = randomZombieHordePoint(world);
		createZombie(world, point.x, point.y);
	}
	notice(world, `Admin deployed ${safeCount} hostile units.`);
	return safeCount;
}

export function grantPlayerSoldiers(
	world: World,
	playerId: PlayerId,
	count: number,
): number {
	if (!world.players[playerId]) return 0;
	const safeCount = clamp(Math.floor(count), 1, 500);
	const origin = playerSpawnCenter(world, playerId);
	const existingSoldiers = Object.values(world.units).filter(
		(unit) => unit.ownerId === playerId && unit.type === "soldier",
	).length;
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

export function grantPlayerResource(
	world: World,
	playerId: PlayerId,
	resource: ResourceType,
	amount: number,
): number | null {
	const player = world.players[playerId];
	if (!player) return null;
	const safeAmount = clamp(Math.floor(amount), 1, 100000);
	player.resources[resource] = (player.resources[resource] || 0) + safeAmount;
	return player.resources[resource];
}

/** Dev tool: toggles invincibility on the player's town center and returns the new state. */
export function toggleTownCenterInvincibility(
	world: World,
	playerId: PlayerId,
): boolean | null {
	const townCenter = Object.values(world.buildings).find(
		(building) =>
			building.ownerId === playerId && building.type === "townCenter",
	);
	if (!townCenter) return null;
	townCenter.invincible = !townCenter.invincible;
	return townCenter.invincible;
}

/** Dev tool: emits a one-off loud "bang" at a map point so zombies are drawn to it. */
export function emitDevBang(world: World, x: number, y: number): void {
	const point = { x: clamp(x, 0, MAP_SIZE), y: clamp(y, 0, MAP_SIZE) };
	const existing = world.actionNoises.find(
		(noise) => noise.action === "devBang",
	);
	if (existing) {
		existing.x = point.x;
		existing.y = point.y;
		existing.sound = DEV_BANG_SOUND;
		existing.remaining = DEV_BANG_DURATION;
		return;
	}
	world.actionNoises.push({
		id: id("s"),
		action: "devBang",
		x: point.x,
		y: point.y,
		sound: DEV_BANG_SOUND,
		remaining: DEV_BANG_DURATION,
	});
	while (world.actionNoises.length > MAX_ACTION_NOISES)
		world.actionNoises.shift();
}

function playerSpawnCenter(world: World, playerId: PlayerId) {
	const townCenter = Object.values(world.buildings).find(
		(building) =>
			building.ownerId === playerId && building.type === "townCenter",
	);
	if (townCenter) return centerOf(townCenter);
	const building = Object.values(world.buildings).find(
		(entity) => entity.ownerId === playerId,
	);
	if (building) return centerOf(building);
	const unit = Object.values(world.units).find(
		(entity) => entity.ownerId === playerId,
	);
	return unit
		? { x: unit.x, y: unit.y }
		: { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };
}

function soldierGrantPoint(
	world: World,
	origin: { x: number; y: number },
	index: number,
) {
	const columns = 24;
	const spacing = 0.9;
	const row = Math.floor(index / columns);
	const column = index % columns;
	const base = {
		x: origin.x + (column - (columns - 1) / 2) * spacing,
		y: origin.y + 3 + row * spacing,
	};
	if (isWalkable(world, Math.floor(base.x), Math.floor(base.y))) {
		return {
			x: clamp(base.x, 0.2, MAP_SIZE - 0.2),
			y: clamp(base.y, 0.2, MAP_SIZE - 0.2),
		};
	}
	for (let radius = 1; radius <= 12; radius += 1) {
		for (let dy = -radius; dy <= radius; dy += 1) {
			for (let dx = -radius; dx <= radius; dx += 1) {
				if (Math.abs(dx) !== radius && Math.abs(dy) !== radius)
					continue;
				const x = Math.floor(origin.x + dx);
				const y = Math.floor(origin.y + dy);
				if (isWalkable(world, x, y)) return { x: x + 0.5, y: y + 0.5 };
			}
		}
	}
	return {
		x: clamp(origin.x, 0.2, MAP_SIZE - 0.2),
		y: clamp(origin.y, 0.2, MAP_SIZE - 0.2),
	};
}

function randomZombieHordePoint(world: World): { x: number; y: number } {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const point = {
			x: randomInt(1, MAP_SIZE - 2) + 0.5,
			y: randomInt(1, MAP_SIZE - 2) + 0.5,
		};
		if (isWalkable(world, Math.floor(point.x), Math.floor(point.y)))
			return point;
	}
	return {
		x: randomInt(1, MAP_SIZE - 2) + 0.5,
		y: randomInt(1, MAP_SIZE - 2) + 0.5,
	};
}

export function command(
	world: World,
	playerId: PlayerId,
	body: CommandPayload,
): CommandResult {
	const player = getOwn(world.players, playerId);
	if (!player || player.defeated)
		return { ok: false, error: "Player unavailable." };
	ensureOccupancy(world);
	const handler = hasOwn(COMMAND_HANDLERS, body.type)
		? COMMAND_HANDLERS[body.type]
		: null;
	if (!handler) return { ok: false, error: "Unknown command." };
	return handler(world, playerId, body as never);
}

export function stepWorld(world: World, dt: number) {
	const tickStartedAt = performance.now();
	const profiling = hasAdminViewer(world);
	updateServerTps(world, tickStartedAt);
	const profiler = new TickProfiler();
	try {
		world.tick += 1;
		profiler.measure("occupancy", "Occupancy", () => ensureOccupancy(world));
		const context = profiler.measure("context", "Context grids", () =>
			createSimulationContext(world),
		);
		profiler.measure("spawner", "Spawning", () =>
			stepSpawner(context, zombieSpawnPolicy, dt),
		);
		profiler.measure("zombieDirector", "Zombie director", () =>
			simulationServices.zombieDirector.step(world, dt),
		);
		profiler.measure("decay", "Decay", () => {
			stepActionNoises(world, dt);
			stepResourceDecay(world, dt);
			stepRuinDecay(world, dt);
			stepCorpseDecay(world, dt);
		});
		profiler.measure("units", "Unit AI", () =>
			stepUnits(world, context, dt, profiling),
		);
		profiler.measure("separation", "Unit separation", () =>
			resolveUnitSeparation(world),
		);
		profiler.measure("buildings", "Buildings", () => {
			for (const building of Object.values(world.buildings))
				stepBuilding(world, context, building, dt);
		});
		profiler.measure("leaderboard", "Players/score", () => {
			for (const playerId of Object.keys(world.players)) {
				const player = world.players[playerId]!;
				player.statistics?.advance(dt, player.workerCounts.idle);
				recalcPlayer(world, playerId);
			}
			updateLeaderboard(world);
		});
	} finally {
		updateServerTickDuration(
			world,
			performance.now() - tickStartedAt,
			profiler.phases(),
		);
	}
}

class TickProfiler {
	private readonly timings: Array<{
		name: string;
		label: string;
		ms: number;
	}> = [];

	measure<T>(name: string, label: string, work: () => T): T {
		const startedAt = performance.now();
		try {
			return work();
		} finally {
			this.timings.push({
				name,
				label,
				ms: performance.now() - startedAt,
			});
		}
	}

	phases(): ServerPerfPhase[] {
		const total = this.timings.reduce((sum, phase) => sum + phase.ms, 0);
		return this.timings.map((phase) => ({
			...phase,
			percent: total > 0 ? (phase.ms / total) * 100 : 0,
		}));
	}
}

function stepUnits(
	world: World,
	context: UnitSimulationContext,
	dt: number,
	profiling: boolean,
) {
	const zombiePerf: ServerPerfZombieStats = {
		total: 0,
		stepped: 0,
		skipped: 0,
		near: 0,
		mid: 0,
		far: 0,
	};
	const unitProfiler = profiling ? new UnitAiProfiler() : null;
	const zombieSteps: ZombieAiStep[] = [];
	const playerSteps: Array<{ unit: Unit; dt: number }> = [];
	world._zombiePerf = zombiePerf;
	const scanUnits = () =>
		collectUnitSteps(
			world,
			context,
			dt,
			zombiePerf,
			zombieSteps,
			playerSteps,
		);
	if (unitProfiler)
		unitProfiler.measurePhase(
			"unitAiScan",
			"Unit AI scan/cadence",
			Object.keys(world.units).length,
			scanUnits,
		);
	else scanUnits();
	for (const step of playerSteps) {
		const behavior = unitBehavior(step.unit);
		if (unitProfiler)
			unitProfiler.measureUnit(step.unit, () =>
				behavior.step(context, step.unit, step.dt),
			);
		else behavior.step(context, step.unit, step.dt);
	}
	if (
		!simulationServices.zombieAi.step(
			world,
			dt,
			zombieSteps,
			(attack) => applyZombieAiAttack(world, attack),
			unitProfiler,
		)
	) {
		stepZombieBatch(world, context, zombieSteps, unitProfiler);
	}
	if (unitProfiler) world._unitAiPerf = unitProfiler.stats();
}

function stepZombieBatch(
	world: World,
	context: UnitSimulationContext,
	zombieSteps: ZombieAiStep[],
	unitProfiler: UnitAiProfiler | null,
) {
	for (const zombieStep of zombieSteps) {
		const unit = world.units[zombieStep.id];
		if (!unit) continue;
		const behavior = unitBehavior(unit);
		if (unitProfiler)
			unitProfiler.measureUnit(unit, () =>
				behavior.step(context, unit, zombieStep.dt),
			);
		else behavior.step(context, unit, zombieStep.dt);
	}
}

function collectUnitSteps(
	world: World,
	context: UnitSimulationContext,
	dt: number,
	zombiePerf: ServerPerfZombieStats,
	zombieSteps: ZombieAiStep[],
	playerSteps: Array<{ unit: Unit; dt: number }>,
) {
	for (const unit of Object.values(world.units)) {
		const cadence =
			unit.type === "zombie"
				? Math.max(1, context.zombieUpdateCadence?.(unit) ?? 1)
				: 1;
		if (unit.type === "zombie") recordZombieCadence(zombiePerf, cadence);
		if (
			cadence > 1 &&
			world.tick % cadence !== unitUpdateSlot(unit, cadence)
		) {
			if (unit.type === "zombie") zombiePerf.skipped += 1;
			continue;
		}
		if (unit.type === "zombie") {
			zombiePerf.stepped += 1;
			zombieSteps.push({ id: unit.id, dt: dt * cadence, cadence });
			continue;
		}
		playerSteps.push({ unit, dt: dt * cadence });
	}
}

function applyZombieAiAttack(world: World, attack: ZombieAiAttackIntent) {
	const attacker = world.units[attack.attackerId];
	const target =
		world.units[attack.targetId as UnitId] ||
		world.buildings[attack.targetId as BuildingId] ||
		world.corpses[attack.targetId as keyof typeof world.corpses];
	if (!attacker || attacker.type !== "zombie" || attacker.hp <= 0 || !target)
		return;
	damage(world, target, attack.amount, attack.attackerOwnerId, attacker);
	attacker.cooldown = attack.cooldown;
	attacker.attackFlash = attack.attackFlash;
}

class UnitAiProfiler {
	private readonly buckets = new Map<
		string,
		{ label: string; count: number; ms: number }
	>();

	measureUnit(unit: Unit, work: () => void) {
		const name = this.bucketName(unit);
		this.measureBucket(name, this.bucketLabel(unit), 1, work);
	}

	measurePhase<T>(
		name: string,
		label: string,
		count: number,
		work: () => T,
	): T {
		return this.measureBucket(name, label, count, work);
	}

	measure<T>(name: string, label: string, count: number, work: () => T): T {
		return this.measureBucket(name, label, count, work);
	}

	private measureBucket<T>(
		name: string,
		label: string,
		count: number,
		work: () => T,
	): T {
		const startedAt = performance.now();
		try {
			return work();
		} finally {
			const bucket = this.buckets.get(name) ?? { label, count: 0, ms: 0 };
			bucket.count += count;
			bucket.ms += performance.now() - startedAt;
			this.buckets.set(name, bucket);
		}
	}

	stats(): ServerPerfUnitAiStats[] {
		return [...this.buckets.entries()]
			.map(([name, bucket]) => ({
				name,
				label: bucket.label,
				count: bucket.count,
				ms: bucket.ms,
				averageMs: bucket.count > 0 ? bucket.ms / bucket.count : 0,
			}))
			.sort((a, b) => b.ms - a.ms);
	}

	private bucketName(unit: Unit) {
		if (unit.type === "zombie") return "zombie";
		return `${unit.type}:${unit.command?.type ?? "idle"}`;
	}

	private bucketLabel(unit: Unit) {
		if (unit.type === "zombie") return "Zombies";
		return `${unitBehavior(unit).label} ${unit.command?.type ?? "idle"}`;
	}
}

function recordZombieCadence(stats: ServerPerfZombieStats, cadence: number) {
	stats.total += 1;
	if (cadence <= ZOMBIE_NEAR_CADENCE_TICKS) stats.near += 1;
	else if (cadence <= ZOMBIE_MID_CADENCE_TICKS) stats.mid += 1;
	else stats.far += 1;
}

function unitUpdateSlot(unit: Unit, cadence: number) {
	return unitHash(unit.id) % cadence;
}

function unitHash(idValue: string): number {
	let hash = 0;
	for (let i = 0; i < idValue.length; i += 1)
		hash = (hash * 31 + idValue.charCodeAt(i)) | 0;
	return Math.abs(hash);
}

function hasOwn<T>(record: Record<string, T>, key: string) {
	return Object.prototype.hasOwnProperty.call(record, key);
}

function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
	return hasOwn(record, key) ? record[key] : undefined;
}

type CommandHandler<T extends CommandPayload["type"]> = (
	world: World,
	playerId: PlayerId,
	body: Extract<CommandPayload, { type: T }>,
) => CommandResult;

const COMMAND_HANDLERS: { [K in CommandPayload["type"]]: CommandHandler<K> } = {
	move: commandMove,
	build: commandBuild,
	buildWallLine: commandBuildWallLine,
	instantBuild: commandInstantBuild,
	finishBuild: commandFinishBuild,
	deleteBuilding: commandDeleteBuilding,
	deleteUnit: commandDeleteUnit,
	setRallyPoint: commandSetRallyPoint,
	train: commandTrain,
	attack: commandAttack,
	gather: commandGather,
	blowHorn: commandBlowHorn,
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

function updateServerTickDuration(
	world: World,
	tickMs: number,
	phases: ServerPerfPhase[],
) {
	world.serverPerf.tickMs = smoothMetric(world.serverPerf.tickMs, tickMs);
	world.serverPerf.phases = phases;
	if (world._zombiePerf) world.serverPerf.zombies = world._zombiePerf;
	if (world._unitAiPerf) world.serverPerf.unitAi = world._unitAiPerf;
	if (world._zombieWorkerPerf)
		world.serverPerf.zombieWorker = world._zombieWorkerPerf;
	if (world._zombieAiWorkerPerf)
		world.serverPerf.zombieAiWorker = world._zombieAiWorkerPerf;
	const sample = {
		tick: world.tick,
		tps: world.serverPerf.tps,
		tickMs: world.serverPerf.tickMs,
		at: Date.now(),
		phases,
		...(world._zombiePerf ? { zombies: world._zombiePerf } : {}),
		...(world._unitAiPerf ? { unitAi: world._unitAiPerf } : {}),
		...(world._zombieWorkerPerf
			? { zombieWorker: world._zombieWorkerPerf }
			: {}),
		...(world._zombieAiWorkerPerf
			? { zombieAiWorker: world._zombieAiWorkerPerf }
			: {}),
	};
	world.serverPerf.samples.push(sample);
	if (world.serverPerf.samples.length > SERVER_PERF_SAMPLE_LIMIT) {
		world.serverPerf.samples.splice(
			0,
			world.serverPerf.samples.length - SERVER_PERF_SAMPLE_LIMIT,
		);
	}
}

export function recordServerPerfPhase(
	world: World,
	name: string,
	label: string,
	ms: number,
) {
	const phases = [...(world.serverPerf.phases ?? [])];
	const existing = phases.find((phase) => phase.name === name);
	if (existing) existing.ms += ms;
	else phases.push({ name, label, ms, percent: 0 });
	const total = phases.reduce((sum, phase) => sum + phase.ms, 0);
	for (const phase of phases)
		phase.percent = total > 0 ? (phase.ms / total) * 100 : 0;
	world.serverPerf.phases = phases;
	const sample = world.serverPerf.samples.at(-1);
	if (sample?.tick === world.tick) sample.phases = phases;
}

function hasAdminViewer(world: World) {
	return Object.values(world.players).some((player) => player.adminLevel);
}

function smoothMetric(current: number, next: number) {
	if (current <= 0) return next;
	return current * (1 - SERVER_PERF_SMOOTHING) + next * SERVER_PERF_SMOOTHING;
}

function createSimulationContext(
	world: World,
): UnitSimulationContext & import("./zombieSpawning.js").ZombieSpawnContext {
	const zombieCadence = new ZombieUpdateCadence(world);
	const playerPathfinder = new PlayerUnitPathfinder(world);
	const unitGridsByOwner = unitTargetGridsByOwner(world);
	const buildingGrid = new SpatialGrid(
		Object.values(world.buildings).filter((building) => building.hp > 0),
		TARGET_UNIT_GRID_CELL_SIZE,
	);
	const targetUnitGrid = new SpatialGrid(
		Object.values(world.units).filter(
			(unit) => unit.type !== "zombie" && unit.hp > 0,
		),
		TARGET_UNIT_GRID_CELL_SIZE,
	);
	return {
		world,
		setCommand: (unit, command) => setUnitCommand(world, unit, command),
		targetById: (targetId) =>
			world.units[targetId as UnitId] ||
			world.buildings[targetId as BuildingId] ||
			world.corpses[targetId as keyof typeof world.corpses] ||
			null,
		buildingById: (buildingId) =>
			world.buildings[buildingId as BuildingId] || null,
		isComplete,
		unitSoundLevel: (unit) => unitBehavior(unit).soundLevel(),
		moveWithPath: (unit, command, maxStep) =>
			playerPathfinder.moveWithPath(unit, command, maxStep),
		moveNearTarget: (unit, command, target, range, maxStep) =>
			playerPathfinder.moveNearTarget(unit, command, target, range, maxStep),
		moveUnit: (unit, target, maxStep) =>
			moveUnit(world, unit, target, maxStep),
		moveZombieWithPath: (unit, target, maxStep) =>
			moveZombieWithPath(world, unit, target, maxStep),
		moveZombieSteered: (unit, target, maxStep) =>
			moveZombieSteered(world, unit, target, maxStep),
		moveAroundSmallObstacle: (unit, target, maxStep) =>
			moveAroundSmallObstacle(world, unit, target, maxStep),
		centerOf,
		distance,
		nearestEnemy: (source, range) =>
			nearestEnemy(world, unitGridsByOwner, buildingGrid, source, range),
		nearbyTargetUnits: (source, range) =>
			targetUnitGrid
				.nearby(source, range)
				.map((entry) => entry.item)
				.filter(
					(unit) =>
						world.units[unit.id] === unit &&
						unit.type !== "zombie" &&
						unit.hp > 0,
				),
		nearestTargetUnit: (source, range) =>
			nearestTargetUnit(world, targetUnitGrid, source, range),
		nearestTargetBuilding: (source, range) =>
			nearestTargetBuilding(world, buildingGrid, source, range),
		damage: (target, amount, attackerId, attacker) =>
			damage(world, target, amount, attackerId, attacker),
		emitActionSound: (action, point) =>
			emitActionSound(world, action, point),
		gatherTarget: (targetId, playerId) =>
			world.resources[targetId as keyof typeof world.resources] ||
			gatherableBuilding(
				world.buildings[targetId as BuildingId],
				playerId,
			),
		gatherResource,
		gatherTargetFor,
		gatherRange: (entity) =>
			isBuilding(entity) ? entity.gatherRange : RESOURCE_GATHER_RANGE,
		isBuilding,
		nearestDepot: (ownerId, resource, source) =>
			nearestDepot(world, ownerId, resource, source),
		findNextResource: (unit, resourceKind) =>
			findNextResource(world, unit, resourceKind),
		findAlternateResource: (unit, resourceKind, currentTarget) =>
			findAlternateResource(world, unit, resourceKind, currentTarget),
		maybeAutoReplenishBuilding: (building) =>
			maybeAutoReplenishBuilding(world, building),
		deleteResource: (resource) => removeResource(world, resource),
		makeStump,
		depositResource: (ownerId, resource, amount) => {
			world.players[ownerId]!.resources[resource] += amount;
			world.players[ownerId]!.statistics?.recordResourcesCollected(resource, amount);
		},
		findNextBuildSite: (unit) => findNextBuildSite(world, unit),
		assignPostBuildGather: (unit, resourceKind, builtFarm = null) =>
			assignPostBuildGather(world, unit, resourceKind, builtFarm),
		attackBlockingBuilding: (unit, targetPoint) =>
			attackBlockingBuilding(world, unit, targetPoint),
		hasPathToTarget: (unit, targetPoint, range) =>
			hasPathToInteractionRange(world, unit, targetPoint, range),
		hasReasonablePathToTarget: (unit, targetPoint, range) =>
			hasReasonableZombiePathToTarget(world, unit, targetPoint, range),
		blockingBuildingToward: (unit, targetPoint) =>
			blockingBuildingToward(world, unit, targetPoint),
		wallLikeBlockingBuildingToward: (unit, targetPoint) =>
			wallLikeBlockingBuildingToward(world, unit, targetPoint),
		zombieUpdateCadence: (unit) => zombieCadence.cadenceFor(unit),
		zombieAiCadence: (unit) => zombieCadence.cadenceFor(unit),
		createZombie: (point) => createZombie(world, point.x, point.y),
		isWalkable: (x, y) => isWalkable(world, x, y),
		weightedWorldSound: () => weightedWorldSound(world),
		unitVision: (unit) => unit.vision || unitBehavior(unit).vision || 5,
		randomInt,
	};
}

class ZombieUpdateCadence {
	private readonly state: NonNullable<World["_zombieCadenceField"]>;

	constructor(private readonly world: World) {
		this.state = this.currentField();
	}

	cadenceFor(unit: Unit) {
		if (this.state.watchedPoints === 0) return ZOMBIE_FAR_CADENCE_TICKS;
		const cellX = clamp(
			Math.floor(unit.x / this.state.cellSize),
			0,
			this.state.width - 1,
		);
		const cellY = clamp(
			Math.floor(unit.y / this.state.cellSize),
			0,
			this.state.height - 1,
		);
		return (
			this.state.field[cellY * this.state.width + cellX] ||
			ZOMBIE_FAR_CADENCE_TICKS
		);
	}

	private currentField() {
		const cached = this.world._zombieCadenceField;
		if (
			cached &&
			cached.cellSize === ZOMBIE_CADENCE_FIELD_CELL_SIZE &&
			this.world.tick - cached.builtTick <
				ZOMBIE_CADENCE_FIELD_REBUILD_TICKS
		) {
			return cached;
		}
		const watchedPoints = this.collectWatchedPoints();
		const width = Math.ceil(MAP_SIZE / ZOMBIE_CADENCE_FIELD_CELL_SIZE);
		const height = Math.ceil(MAP_SIZE / ZOMBIE_CADENCE_FIELD_CELL_SIZE);
		const field = new Uint8Array(width * height);
		field.fill(ZOMBIE_FAR_CADENCE_TICKS);
		for (const point of watchedPoints)
			this.stampCadence(
				field,
				width,
				height,
				point,
				ZOMBIE_MID_VISION_DISTANCE,
				ZOMBIE_MID_CADENCE_TICKS,
			);
		for (const point of watchedPoints)
			this.stampCadence(
				field,
				width,
				height,
				point,
				ZOMBIE_NEAR_VISION_DISTANCE,
				ZOMBIE_NEAR_CADENCE_TICKS,
			);
		this.world._zombieCadenceField = {
			builtTick: this.world.tick,
			cellSize: ZOMBIE_CADENCE_FIELD_CELL_SIZE,
			width,
			height,
			field,
			watchedPoints: watchedPoints.length,
		};
		return this.world._zombieCadenceField;
	}

	private collectWatchedPoints() {
		const points: Vec2[] = [];
		for (const unit of Object.values(this.world.units)) {
			if (unit.ownerId === ZOMBIE_OWNER_ID || unit.hp <= 0) continue;
			points.push(unit);
		}
		for (const building of Object.values(this.world.buildings)) {
			if (building.ownerId === ZOMBIE_OWNER_ID || building.hp <= 0)
				continue;
			points.push(centerOf(building));
		}
		return points;
	}

	private stampCadence(
		field: Uint8Array,
		width: number,
		height: number,
		point: Vec2,
		radius: number,
		cadence: number,
	) {
		const cellSize = ZOMBIE_CADENCE_FIELD_CELL_SIZE;
		const minCellX = clamp(
			Math.floor((point.x - radius) / cellSize),
			0,
			width - 1,
		);
		const maxCellX = clamp(
			Math.floor((point.x + radius) / cellSize),
			0,
			width - 1,
		);
		const minCellY = clamp(
			Math.floor((point.y - radius) / cellSize),
			0,
			height - 1,
		);
		const maxCellY = clamp(
			Math.floor((point.y + radius) / cellSize),
			0,
			height - 1,
		);
		const radiusSq = radius * radius;
		for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
			const y = cellY * cellSize + cellSize / 2;
			for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
				const x = cellX * cellSize + cellSize / 2;
				const dx = x - point.x;
				const dy = y - point.y;
				if (dx * dx + dy * dy > radiusSq) continue;
				const index = cellY * width + cellX;
				if (cadence < field[index]!) field[index] = cadence;
			}
		}
	}
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
				if (x >= 0 && y >= 0 && x < size && y < size)
					grid[y * size + x] = 1;
			}
		}
	}
	if (!previous || occupancyChanged(previous, grid)) {
		invalidatePathing(world);
	}
}

function ensureOccupancy(world: World) {
	if (!world._occupancy || world._occupancy.length !== MAP_SIZE * MAP_SIZE)
		rebuildOccupancy(world);
}

function removeBuilding(world: World, building: Building) {
	if (!world.buildings[building.id]) return;
	delete world.buildings[building.id];
	markBuildingOccupancy(world, building, false);
}

function removeResource(world: World, resource: ResourceNode) {
	if (!world.resources[resource.id]) return;
	delete world.resources[resource.id];
	markResourceOccupancy(world, resource, false);
}

function markBuildingOccupancy(world: World, building: Building, occupied: boolean) {
	if (!building.walkBlocking) return;
	markOccupancyFootprint(world, building, occupied);
}

function markResourceOccupancy(world: World, resource: ResourceNode, occupied: boolean) {
	markOccupancyFootprint(world, {
		x: Math.round(resource.x),
		y: Math.round(resource.y),
		width: 1,
		height: 1,
	}, occupied);
}

function markOccupancyFootprint(world: World, footprint: Footprint, occupiedValue: boolean) {
	if (!world._occupancy || world._occupancy.length !== MAP_SIZE * MAP_SIZE) return;
	const value = occupiedValue ? 1 : 0;
	let changed = false;
	for (let dy = 0; dy < footprintHeight(footprint); dy += 1) {
		for (let dx = 0; dx < footprintWidth(footprint); dx += 1) {
			const x = Math.floor(footprint.x) + dx;
			const y = Math.floor(footprint.y) + dy;
			if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE) continue;
			const index = y * MAP_SIZE + x;
			if (world._occupancy[index] === value) continue;
			world._occupancy[index] = value;
			changed = true;
		}
	}
	if (changed) invalidatePathing(world);
}

function invalidatePathing(world: World) {
	const pathing = ensurePathingState(world);
	if ((pathing.occupancyBatchDepth ?? 0) > 0) {
		pathing.occupancyBatchChanged = true;
		return;
	}
	invalidatePathingNow(pathing);
}

function batchOccupancyUpdates<T>(world: World, work: () => T): T {
	const pathing = ensurePathingState(world);
	pathing.occupancyBatchDepth = (pathing.occupancyBatchDepth ?? 0) + 1;
	try {
		return work();
	} finally {
		pathing.occupancyBatchDepth = Math.max(0, (pathing.occupancyBatchDepth ?? 1) - 1);
		if (pathing.occupancyBatchDepth === 0 && pathing.occupancyBatchChanged) {
			pathing.occupancyBatchChanged = false;
			invalidatePathingNow(pathing);
		}
	}
}

function ensurePathingState(world: World) {
	world._pathing ??= {
		occupancyVersion: 0,
		flowFields: new Map(),
		clearanceFields: new Map(),
		arrivalGroups: new Map(),
		pathRequestsThisTick: 0,
		lastRequestTick: -1,
	};
	return world._pathing;
}

function invalidatePathingNow(pathing: NonNullable<World["_pathing"]>) {
	pathing.occupancyVersion += 1;
	pathing.flowFields.clear();
	pathing.clearanceFields.clear();
	pathing.arrivalGroups.clear();
	delete pathing.hardBlockingTiles;
	delete pathing.blockingBuildingsByTile;
	delete pathing.ownGateTiles;
	delete pathing.ownGateSignature;
	delete pathing.resourceGrid;
	delete pathing.clearMovementLineCache;
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
	seedResourcePiles(
		world,
		placement,
		"ore",
		ORE_VEIN_COUNT,
		() => 5 + Math.floor(Math.random() * 4),
	);
	seedResourcePiles(
		world,
		placement,
		"berry",
		BERRY_PATCH_COUNT,
		() => 4 + Math.floor(Math.random() * 4),
	);
}

function seedTrees(world: World, placement: ResourcePlacementTracker) {
	for (
		let forest = 0, attempt = 0;
		forest < FOREST_COUNT &&
		attempt < FOREST_COUNT * RESOURCE_CLUSTER_SEED_ATTEMPT_MULTIPLIER;
		attempt += 1
	) {
		if (seedForest(world, placement, randomResourcePoint())) forest += 1;
	}
	for (
		let tree = 0, attempt = 0;
		tree < LONE_TREE_COUNT &&
		attempt < LONE_TREE_COUNT * RESOURCE_CLUSTER_SEED_ATTEMPT_MULTIPLIER;
		attempt += 1
	) {
		const point = randomResourcePoint();
		if (!placement.canPlaceCluster([point])) continue;
		placement.placeCluster("tree", [point]);
		tree += 1;
	}
}

function seedForest(
	world: World,
	placement: ResourcePlacementTracker,
	center: Vec2,
) {
	const radiusX =
		FOREST_MIN_RADIUS + Math.floor(Math.random() * FOREST_RADIUS_VARIANCE);
	const radiusY =
		FOREST_MIN_RADIUS + Math.floor(Math.random() * FOREST_RADIUS_VARIANCE);
	const wobble = Math.random() * Math.PI * 2;
	const pinch = Math.random() * Math.PI * 2;
	const tiles: Vec2[] = [];

	for (let dy = -radiusY; dy <= radiusY; dy += 1) {
		for (let dx = -radiusX; dx <= radiusX; dx += 1) {
			if (!insideForestShape(dx, dy, radiusX, radiusY, wobble, pinch))
				continue;
			tiles.push({ x: center.x + dx, y: center.y + dy });
		}
	}
	if (!placement.canPlaceCluster(tiles)) return false;
	placement.placeCluster("tree", tiles);
	return true;
}

function insideForestShape(
	dx: number,
	dy: number,
	radiusX: number,
	radiusY: number,
	wobble: number,
	pinch: number,
) {
	const angle = Math.atan2(dy, dx);
	const localRadiusX =
		radiusX *
		(0.85 +
			Math.sin(angle * 2 + pinch) * 0.18 +
			Math.cos(angle * 4 - wobble) * 0.12);
	const localRadiusY =
		radiusY *
		(0.85 +
			Math.cos(angle * 3 - pinch) * 0.16 +
			Math.sin(angle * 5 + wobble) * 0.1);
	const edge =
		0.92 +
		Math.sin(angle * 3 + wobble) * 0.2 +
		Math.cos(angle * 7 - pinch) * 0.12;
	const normalized =
		(dx * dx) / (localRadiusX * localRadiusX) +
		(dy * dy) / (localRadiusY * localRadiusY);
	return normalized <= edge;
}

function randomResourcePoint(): Vec2 {
	return {
		x: 4 + Math.floor(Math.random() * (MAP_SIZE - 8)),
		y: 4 + Math.floor(Math.random() * (MAP_SIZE - 8)),
	};
}

function seedResourcePiles(
	world: World,
	placement: ResourcePlacementTracker,
	type: "ore" | "berry",
	count: number,
	pileSize: () => number,
) {
	for (
		let pile = 0, attempt = 0;
		pile < count &&
		attempt < count * RESOURCE_CLUSTER_SEED_ATTEMPT_MULTIPLIER;
		attempt += 1
	) {
		if (
			seedConnectedResourcePile(
				placement,
				type,
				randomResourcePoint(),
				pileSize(),
			)
		)
			pile += 1;
	}
}

function seedConnectedResourcePile(
	placement: ResourcePlacementTracker,
	type: "ore" | "berry",
	center: Vec2,
	count: number,
) {
	const placed: Vec2[] = [];
	if (!placement.canPlaceCluster([center])) return false;
	placed.push(center);

	for (
		let attempt = 0;
		placed.length < count && attempt < RESOURCE_PILE_PLACEMENT_ATTEMPTS;
		attempt += 1
	) {
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
	return (
		Math.round(a.x) === Math.round(b.x) &&
		Math.round(a.y) === Math.round(b.y)
	);
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
		for (const resource of Object.values(world.resources))
			this.mark(resource);
	}

	canPlaceCluster(tiles: Vec2[]) {
		return tiles.every((tile) => this.canPlaceTile(tile));
	}

	placeCluster(type: "tree" | "ore" | "berry", tiles: Vec2[]) {
		for (const tile of tiles) {
			const resource = createSeedResource(
				this.world,
				type,
				tile.x,
				tile.y,
			);
			if (resource) this.mark(resource);
		}
	}

	private canPlaceTile(point: Vec2) {
		const x = Math.round(point.x);
		const y = Math.round(point.y);
		if (x < 1 || y < 1 || x > MAP_SIZE - 2 || y > MAP_SIZE - 2)
			return false;
		for (
			let dy = -RESOURCE_CLUSTER_GAP;
			dy <= RESOURCE_CLUSTER_GAP;
			dy += 1
		) {
			for (
				let dx = -RESOURCE_CLUSTER_GAP;
				dx <= RESOURCE_CLUSTER_GAP;
				dx += 1
			) {
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
	for (const [type, rx, ry] of spots)
		createResource(world, type as "tree" | "ore" | "berry", rx, ry);
}

function chooseSpawn(world: World, _count: number) {
	const existingTownCenters = Object.values(world.buildings).filter(
		(building) => building.type === "townCenter",
	);
	let best = randomInteriorPoint();
	let bestScore = -Infinity;
	for (let attempt = 0; attempt < PLAYER_SPAWN_ATTEMPTS; attempt += 1) {
		const candidate = randomInteriorPoint();
		if (!canSpawnTownCenterAt(world, candidate.x, candidate.y)) continue;
		const nearestTownCenter = existingTownCenters.reduce(
			(min, building) =>
				Math.min(min, distance(candidate, centerOf(building))),
			Infinity,
		);
		if (nearestTownCenter < MIN_PLAYER_SPAWN_DISTANCE) continue;
		const edgeDistance = Math.min(
			candidate.x,
			candidate.y,
			MAP_SIZE - candidate.x,
			MAP_SIZE - candidate.y,
		);
		const centerDistance = distance(candidate, {
			x: MAP_SIZE / 2,
			y: MAP_SIZE / 2,
		});
		const score =
			nearestTownCenter +
			edgeDistance * 0.35 +
			Math.random() * 10 -
			centerDistance * 0.05;
		if (score > bestScore) {
			best = candidate;
			bestScore = score;
		}
	}
	return best;
}

function randomInteriorPoint() {
	return {
		x:
			PLAYER_SPAWN_MARGIN +
			Math.floor(Math.random() * (MAP_SIZE - PLAYER_SPAWN_MARGIN * 2)),
		y:
			PLAYER_SPAWN_MARGIN +
			Math.floor(Math.random() * (MAP_SIZE - PLAYER_SPAWN_MARGIN * 2)),
	};
}

function canSpawnTownCenterAt(world: World, x: number, y: number): boolean {
	const size = BUILDING_TYPES.townCenter.size;
	if (
		x < PLAYER_SPAWN_MARGIN ||
		y < PLAYER_SPAWN_MARGIN ||
		x + size > MAP_SIZE - PLAYER_SPAWN_MARGIN ||
		y + size > MAP_SIZE - PLAYER_SPAWN_MARGIN
	)
		return false;
	return Object.values(world.buildings).every(
		(building) => !rectsOverlap({ x, y, size }, building),
	);
}

function createUnit(
	world: World,
	ownerId: PlayerId,
	type: UnitType,
	x: number,
	y: number,
): Unit {
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
	world.players[ownerId]?.statistics?.recordUnitCreated(def);
	addWorkerCommandCount(world, unit, unit.command);
	return unit;
}

function removeUnit(world: World, unit: Unit, combatLoss = false) {
	const behavior = unitBehavior(unit);
	world.players[unit.ownerId]?.statistics?.recordUnitRemoved(behavior, combatLoss);
	removeWorkerCommandCount(world, unit, unit.command);
	delete world.units[unit.id];
}

function setUnitCommand(world: World, unit: Unit, command: UnitCommand) {
	removeWorkerCommandCount(world, unit, unit.command);
	unit.command = command;
	addWorkerCommandCount(world, unit, command);
}

function addWorkerCommandCount(world: World, unit: Unit, command: UnitCommand) {
	updateWorkerCommandCount(world, unit, command, 1);
}

function removeWorkerCommandCount(
	world: World,
	unit: Unit,
	command: UnitCommand,
) {
	updateWorkerCommandCount(world, unit, command, -1);
}

function updateWorkerCommandCount(
	world: World,
	unit: Unit,
	command: UnitCommand,
	delta: 1 | -1,
) {
	if (!unitBehavior(unit).canGather) return;
	const player = world.players[unit.ownerId];
	if (!player) return;
	player.workerCounts ??= createEmptyWorkerCounts();
	if (command.type === "idle") {
		player.workerCounts.idle = Math.max(
			0,
			player.workerCounts.idle + delta,
		);
		return;
	}
	if (command.type !== "gather") return;
	player.workerCounts.gathering[command.resourceKind] = Math.max(
		0,
		player.workerCounts.gathering[command.resourceKind] + delta,
	);
}

function createZombie(
	world: World,
	x: number,
	y: number,
	sprite: Unit["sprite"] = "zombie_def",
): Unit {
	const zombie = createUnit(world, ZOMBIE_OWNER_ID, "zombie", x, y);
	zombie.sprite = sprite;
	zombie.retargetIn = Math.random() * ZOMBIE_INITIAL_RETARGET_SECONDS;
	return zombie;
}

function createCorpse(world: World, unit: Unit) {
	if (unit.type === "zombie") return;
	const corpse: Corpse = {
		id: id("c"),
		kind: "corpse",
		type: "corpse",
		originUnitType: unit.type,
		x: Math.floor(unit.x),
		y: Math.floor(unit.y),
		size: 1,
		hp: 1,
		maxHp: 1,
		ownerId: unit.ownerId,
		remaining: 10 + Math.random() * 20,
		zombieSprite: unit.type === "soldier" ? "zombie_sol" : "zombie_vil",
	};
	world.corpses[corpse.id] = corpse;
}

function createBuilding(
	world: World,
	ownerId: PlayerId,
	type: BuildingType,
	x: number,
	y: number,
	free = false,
): Building | null {
	const def = BUILDING_TYPES[type];
	const building = createBuildingInstance(type, {
		id: id("b"),
		ownerId,
		x,
		y,
	});
	if (!free && !spend(world.players[ownerId]!, def.cost)) return null;
	world.buildings[building.id] = building;
	markBuildingOccupancy(world, building, true);
	return building;
}

function createResource(
	world: World,
	type: keyof typeof RESOURCE_DEFS,
	x: number,
	y: number,
): ResourceNode | null {
	x = clamp(Math.round(x), 1, MAP_SIZE - 2);
	y = clamp(Math.round(y), 1, MAP_SIZE - 2);
	const blocked = [
		...Object.values(world.resources),
		...Object.values(world.buildings),
	].some((entity) => pointInsideEntity(x, y, entity));
	if (blocked) return null;
	return addResourceNode(world, type, x, y);
}

function createSeedResource(
	world: World,
	type: keyof typeof RESOURCE_DEFS,
	x: number,
	y: number,
): ResourceNode {
	return addResourceNode(
		world,
		type,
		clamp(Math.round(x), 1, MAP_SIZE - 2),
		clamp(Math.round(y), 1, MAP_SIZE - 2),
	);
}

function addResourceNode(
	world: World,
	type: keyof typeof RESOURCE_DEFS,
	x: number,
	y: number,
): ResourceNode {
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
	markResourceOccupancy(world, resource, true);
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
	return (
		x >= Math.floor(entity.x) &&
		x < Math.floor(entity.x) + footprintWidth(entity) &&
		y >= Math.floor(entity.y) &&
		y < Math.floor(entity.y) + footprintHeight(entity)
	);
}

function commandMove(
	world: World,
	playerId: PlayerId,
	body: Extract<CommandPayload, { type: "move" }>,
): CommandResult {
	const clusterLandingTargets = new WeakMap<
		Unit[],
		{ x: number; y: number }
	>();
	forOwnUnitClusters(
		world,
		playerId,
		body.unitIds,
		(unit, cluster, index, reservedFormationTargets) => {
			const target = {
				x: clamp(Number(body.x), 0, MAP_SIZE - 1),
				y: clamp(Number(body.y), 0, MAP_SIZE - 1),
			};
				let landingTarget = clusterLandingTargets.get(cluster);
				if (!landingTarget) {
					landingTarget = nearestCommandLandingPoint(
						world,
						target,
						clusterCenter(cluster),
						reservedFormationTargets,
					);
					clusterLandingTargets.set(cluster, landingTarget);
				}
			const moveGroupId = moveGroupIdFor(
				playerId,
				world.tick,
				cluster,
				landingTarget,
			);
			const formationTarget = formationTargetForCluster(
				world,
				landingTarget,
				cluster,
				index,
				reservedFormationTargets,
			);
			unit.hornActive = false;
			setUnitCommand(
				world,
				unit,
				formationTarget
					? moveFormationCommand(
							target,
							cluster.length,
							formationTarget,
							moveGroupId,
							landingTarget,
						)
					: {
							type: "move",
							...target,
							path: null,
							pathCrowd: cluster.length,
							moveGroupId,
							moveGroupTarget: landingTarget,
						},
			);
		},
	);
	return { ok: true };
}

function moveFormationCommand(
	target: { x: number; y: number },
	crowd: number,
	formationTarget: { x: number; y: number },
	moveGroupId: string,
	moveGroupTarget: { x: number; y: number },
) {
	return {
		type: "move" as const,
		...target,
		path: null,
		pathCrowd: crowd,
		formationTarget,
		moveGroupId,
		moveGroupTarget,
	};
}

function moveGroupIdFor(
	playerId: PlayerId,
	tick: number,
	cluster: Unit[],
	target: { x: number; y: number },
) {
	const firstId = cluster[0]?.id ?? "empty";
	return `${playerId}:${tick}:${firstId}:${Math.round(target.x)},${Math.round(target.y)}`;
}

function commandAttack(
	world: World,
	playerId: PlayerId,
	body: Extract<CommandPayload, { type: "attack" }>,
): CommandResult {
	const target =
		getOwn(world.units, body.targetId) ||
		getOwn(world.buildings, body.targetId) ||
		getOwn(world.corpses, body.targetId);
	if (!target || (target.kind !== "corpse" && target.ownerId === playerId))
		return { ok: false, error: "Invalid target." };
	let assigned = false;
	forOwnUnitClusters(world, playerId, body.unitIds, (unit, cluster) => {
		if (target.kind === "corpse" && unit.type !== "soldier") return;
		setUnitCommand(world, unit, {
			type: "attack",
			targetId: target.id,
			path: null,
			pathCrowd: cluster.length,
		});
		assigned = true;
	});
	return assigned
		? { ok: true }
		: { ok: false, error: "Select units to command." };
}

function commandGather(
	world: World,
	playerId: PlayerId,
	body: Extract<CommandPayload, { type: "gather" }>,
): CommandResult {
	const targetBuilding = getOwn(world.buildings, body.targetId);
	const depotResource =
		targetBuilding?.ownerId === playerId && isComplete(targetBuilding)
			? targetBuilding.depotGatherKind()
			: null;
	const depotGatherPoint = targetBuilding && depotResource ? centerOf(targetBuilding) : null;
	const resource =
		getOwn(world.resources, body.targetId) ||
		gatherableBuilding(targetBuilding, playerId) ||
		(depotGatherPoint
			? findNextResourceNear(
					world,
					depotGatherPoint,
					depotResource,
					playerId,
				)
			: null);
	if (!resource) return { ok: false, error: "Invalid resource." };
	let assigned = false;
	const reachability = createGatherReachabilityCache();
	const reservedGatherTargets = new Map<string, number>();
	forOwnUnits(world, playerId, body.unitIds, (unit) => {
		if (unitBehavior(unit).canGather) {
			const requestedResource = depotGatherPoint
				? findNextResourceNear(
						world,
						depotGatherPoint,
						depotResource,
						playerId,
						unit,
						reservedGatherTargets,
					)
				: resource;
			if (!requestedResource) return;
			const assignedResource = reachableGatherResourceForUnit(world, unit, requestedResource, reachability, reservedGatherTargets);
			if (!assignedResource) return;
			if (
				isBuilding(assignedResource) &&
				!buildingHasGathererCapacity(world, assignedResource, unit, reservedGatherTargets)
			)
				return;
			reserveGatherTarget(reservedGatherTargets, assignedResource);
			setUnitCommand(world, unit, {
				type: "gather",
				targetId: assignedResource.id,
				// Remember what this worker was after so we can auto-find another
				// tree / ore vein / farm when the current target is gone.
				resourceKind: gatherResource(assignedResource),
				progress: 0,
				path: null,
			});
			assigned = true;
		}
	});
	return assigned
		? { ok: true }
		: { ok: false, error: "Select gather-capable units." };
}

function commandBlowHorn(
	world: World,
	playerId: PlayerId,
	body: Extract<CommandPayload, { type: "blowHorn" }>,
): CommandResult {
	let toggled = false;
	forOwnUnits(world, playerId, body.unitIds, (unit) => {
		if (unit.type !== "scout") return;
		unit.hornActive = !unit.hornActive;
		if (unit.hornActive) {
			setUnitCommand(world, unit, { type: "idle" });
			emitActionSound(world, "horn", unit);
		}
		unit.workFlash = 0.4;
		toggled = true;
	});
	return toggled ? { ok: true } : { ok: false, error: "Select a scout." };
}

function commandToggleAutoFarm(
	world: World,
	playerId: PlayerId,
): CommandResult {
	const player = getOwn(world.players, playerId);
	if (!player) return { ok: false, error: "Player not found." };
	player.autoReplenishFarms = !player.autoReplenishFarms;
	return { ok: true, autoReplenishFarms: player.autoReplenishFarms };
}

function commandReplenishFarm(
	world: World,
	playerId: PlayerId,
	body: Extract<CommandPayload, { type: "replenishFarm" }>,
): CommandResult {
	const farm = getOwn(world.buildings, body.farmId);
	if (!farm || farm.ownerId !== playerId || !farm.canBeGatheredBy(playerId))
		return { ok: false, error: "Select one of your completed farms." };
	return replenishFarm(world, farm)
		? { ok: true }
		: { ok: false, error: "Not enough wood to reseed farm." };
}

function commandBuild(
	world: World,
	playerId: PlayerId,
	body: Extract<CommandPayload, { type: "build" }>,
): CommandResult {
	const def = BUILDING_TYPES[body.buildingType];
	if (!def) return { ok: false, error: "Unknown building." };
	const { x, y, footprint } = buildPlacement(
		body.buildingType,
		body.x,
		body.y,
	);
	const replacementWall = ownWallAt(world, playerId, x, y);
	if (body.buildingType === "wall" && replacementWall) return { ok: true };
	if (
		!canPlace(
			world,
			x,
			y,
			footprint.width,
			footprint.height,
			replacementWall,
		)
	)
		return { ok: false, error: "Blocked tile." };
	const builders = Object.values(world.units).filter(
		(unit) =>
			unit.ownerId === playerId &&
			body.unitIds?.includes(unit.id) &&
			unitBehavior(unit).canBuild,
	);
	if (builders.length === 0)
		return { ok: false, error: "Select build-capable units." };
	if (body.buildingType === "gate" && replacementWall)
		return replaceWallWithGate(world, playerId, replacementWall, builders);
	const building = createBuilding(world, playerId, body.buildingType, x, y);
	if (!building) return { ok: false, error: "Not enough resources." };
	building.startConstruction(Math.max(12, Math.floor(building.maxHp * 0.25)));
	building.builderIds = builders.map((unit) => unit.id);
	const resourceKind = building.depotGatherKind();
	for (const unit of builders)
		setUnitCommand(world, unit, {
			type: "build",
			targetId: building.id,
			path: null,
			resourceKind,
			gatherBuiltFarm: building.shouldGatherAfterBuild,
		});
	return { ok: true };
}

function commandBuildWallLine(
	world: World,
	playerId: PlayerId,
	body: Extract<CommandPayload, { type: "buildWallLine" }>,
): CommandResult {
	const tiles = normalizeWallLineTiles(body.tiles);
	if (tiles.length === 0) return { ok: false, error: "No wall tiles." };
	const plan = planWallLine(world, playerId, tiles);
	if (!plan.ok) return plan;
	if (body.instant) return instantBuildWallLine(world, playerId, plan.tiles, plan.skipped);
	if (plan.tiles.length === 0)
		return { ok: true, placed: 0, skipped: plan.skipped };
	const builders = buildCapableUnits(world, playerId, body.unitIds);
	if (builders.length === 0)
		return { ok: false, error: "Select build-capable units." };
	const player = getOwn(world.players, playerId);
	if (!player) return { ok: false, error: "Player not found." };
	if (!spend(player, scaleCost(BUILDING_TYPES.wall.cost, plan.tiles.length)))
		return { ok: false, error: "Not enough resources." };
	const buildings = batchOccupancyUpdates(world, () =>
		plan.tiles
			.map((tile) => createBuilding(world, playerId, "wall", tile.x, tile.y, true))
			.filter((building): building is Building => Boolean(building)),
	);
	for (const building of buildings) {
		building.startConstruction(Math.max(12, Math.floor(building.maxHp * 0.25)));
		building.builderIds = builders.map((unit) => unit.id);
	}
	for (const unit of builders) {
		const building = nearestBuilding(unit, buildings);
		if (!building) continue;
		setUnitCommand(world, unit, {
			type: "build",
			targetId: building.id,
			path: null,
			resourceKind: null,
			gatherBuiltFarm: false,
		});
	}
	return { ok: true, placed: buildings.length, skipped: plan.skipped };
}

function normalizeWallLineTiles(tiles: Vec2[]) {
	const unique = new Map<string, Vec2>();
	for (const tile of tiles) {
		const placement = buildPlacement("wall", tile.x, tile.y);
		const key = `${placement.x},${placement.y}`;
		if (!unique.has(key)) unique.set(key, { x: placement.x, y: placement.y });
	}
	return [...unique.values()];
}

function planWallLine(
	world: World,
	playerId: PlayerId,
	tiles: Vec2[],
): { ok: true; tiles: Vec2[]; skipped: number } | { ok: false; error: string } {
	const planned: Vec2[] = [];
	let skipped = 0;
	for (const tile of tiles) {
		if (ownWallAt(world, playerId, tile.x, tile.y)) {
			skipped += 1;
			continue;
		}
		if (!canPlace(world, tile.x, tile.y, 1, 1, null))
			return { ok: false, error: "Blocked tile." };
		planned.push(tile);
	}
	return { ok: true, tiles: planned, skipped };
}

function instantBuildWallLine(
	world: World,
	playerId: PlayerId,
	tiles: Vec2[],
	skipped: number,
): CommandResult {
	const player = getOwn(world.players, playerId);
	if (!player?.adminLevel)
		return { ok: false, error: "Admin access is required." };
	if (tiles.length === 0) return { ok: true, placed: 0, skipped };
	const buildings = batchOccupancyUpdates(world, () =>
		tiles
			.map((tile) => createBuilding(world, playerId, "wall", tile.x, tile.y, true))
			.filter((building): building is Building => Boolean(building)),
	);
	for (const building of buildings) {
		building.markComplete();
		building.hp = building.maxHp;
		building.builderIds = [];
	}
	return { ok: true, placed: buildings.length, skipped };
}

function buildCapableUnits(world: World, playerId: PlayerId, unitIds: UnitId[]) {
	return Object.values(world.units).filter(
		(unit) =>
			unit.ownerId === playerId &&
			unitIds.includes(unit.id) &&
			unitBehavior(unit).canBuild,
	);
}

function nearestBuilding(unit: Unit, buildings: Building[]) {
	let nearest: Building | null = null;
	let nearestDistance = Infinity;
	for (const building of buildings) {
		const d = distance(unit, centerOf(building));
		if (d >= nearestDistance) continue;
		nearest = building;
		nearestDistance = d;
	}
	return nearest;
}

function scaleCost(cost: ResourceCost, multiplier: number): ResourceCost {
	const scaled: ResourceCost = {};
	for (const [resource, amount] of Object.entries(cost) as [ResourceType, number][])
		scaled[resource] = amount * multiplier;
	return scaled;
}

function commandInstantBuild(
	world: World,
	playerId: PlayerId,
	body: Extract<CommandPayload, { type: "instantBuild" }>,
): CommandResult {
	const player = getOwn(world.players, playerId);
	if (!player?.adminLevel)
		return { ok: false, error: "Admin access is required." };
	const def = BUILDING_TYPES[body.buildingType];
	if (!def) return { ok: false, error: "Unknown building." };
	const { x, y, footprint } = buildPlacement(
		body.buildingType,
		body.x,
		body.y,
	);
	const replacementWall = ownWallAt(world, playerId, x, y);
	if (body.buildingType === "wall" && replacementWall) return { ok: true };
	if (
		!canPlace(
			world,
			x,
			y,
			footprint.width,
			footprint.height,
			replacementWall,
		)
	)
		return { ok: false, error: "Blocked tile." };
	if (body.buildingType === "gate" && replacementWall)
		removeBuilding(world, replacementWall);
	const building = createBuilding(
		world,
		playerId,
		body.buildingType,
		x,
		y,
		true,
	);
	if (!building) return { ok: false, error: "Could not place building." };
	building.markComplete();
	building.hp = building.maxHp;
	building.builderIds = [];
	return { ok: true };
}

function buildPlacement(
	buildingType: BuildingType,
	rawX: number,
	rawY: number,
) {
	const def = BUILDING_TYPES[buildingType];
	const footprint = {
		width: ("width" in def ? def.width : def.size) as number,
		height: ("height" in def ? def.height : def.size) as number,
	};
	return {
		x: clamp(Math.round(Number(rawX)), 0, MAP_SIZE - footprint.width),
		y: clamp(Math.round(Number(rawY)), 0, MAP_SIZE - footprint.height),
		footprint,
	};
}

function replaceWallWithGate(
	world: World,
	playerId: PlayerId,
	wall: Building,
	builders: Unit[],
): CommandResult {
	const player = getOwn(world.players, playerId);
	if (!player) return { ok: false, error: "Player not found." };
	const refund = wall.isComplete() ? {} : wall.cost;
	const cost = netCost(BUILDING_TYPES.gate.cost, refund);
	if (!spend(player, cost))
		return { ok: false, error: "Not enough resources." };
	removeBuilding(world, wall);
	const gate = createBuilding(world, playerId, "gate", wall.x, wall.y, true);
	if (!gate) return { ok: false, error: "Could not place gate." };
	gate.startConstruction(Math.max(12, Math.floor(gate.maxHp * 0.25)));
	gate.builderIds = builders.map((unit) => unit.id);
	for (const unit of builders)
		setUnitCommand(world, unit, {
			type: "build",
			targetId: gate.id,
			path: null,
			resourceKind: null,
			gatherBuiltFarm: false,
		});
	return { ok: true };
}

function ownWallAt(world: World, playerId: PlayerId, x: number, y: number) {
	return (
		Object.values(world.buildings).find(
			(building) =>
				building.ownerId === playerId &&
				building.type === "wall" &&
				building.x === x &&
				building.y === y,
		) || null
	);
}

function commandFinishBuild(
	world: World,
	playerId: PlayerId,
	body: Extract<CommandPayload, { type: "finishBuild" }>,
): CommandResult {
	const building = getOwn(world.buildings, body.buildingId);
	if (!building || building.ownerId !== playerId)
		return { ok: false, error: "Invalid building." };
	if (isComplete(building) && building.hp >= building.maxHp)
		return { ok: false, error: "Building is already fully repaired." };
	const builders = Object.values(world.units).filter(
		(unit) =>
			unit.ownerId === playerId &&
			body.unitIds?.includes(unit.id) &&
			unitBehavior(unit).canBuild,
	);
	if (builders.length === 0)
		return { ok: false, error: "Select build-capable units." };
	if (isComplete(building)) {
		const player = getOwn(world.players, playerId);
		if (!player) return { ok: false, error: "Player not found." };
		const cost = repairCost(building);
		if (!spend(player, cost))
			return { ok: false, error: "Not enough resources to repair." };
		building.repairPaidUntilHp = building.maxHp;
	}
	const resourceKind = building.depotGatherKind();
	building.builderIds = [
		...new Set([
			...(building.builderIds || []),
			...builders.map((unit) => unit.id),
		]),
	];
	for (const unit of builders)
		setUnitCommand(world, unit, {
			type: "build",
			targetId: building.id,
			path: null,
			resourceKind,
			gatherBuiltFarm: building.shouldGatherAfterBuild,
		});
	return { ok: true };
}

function commandDeleteBuilding(
	world: World,
	playerId: PlayerId,
	body: Extract<CommandPayload, { type: "deleteBuilding" }>,
): CommandResult {
	const building = getOwn(world.buildings, body.buildingId);
	if (!building || building.ownerId !== playerId)
		return { ok: false, error: "Select one of your buildings." };
	createRuin(world, building);
	removeBuilding(world, building);
	for (const unit of Object.values(world.units)) {
		if ("targetId" in unit.command && unit.command.targetId === building.id)
			setUnitCommand(world, unit, { type: "idle" });
	}
	return { ok: true };
}

function commandDeleteUnit(
	world: World,
	playerId: PlayerId,
	body: Extract<CommandPayload, { type: "deleteUnit" }>,
): CommandResult {
	const units = [...new Set(body.unitIds)]
		.map((unitId) => getOwn(world.units, unitId))
		.filter((unit): unit is Unit => unit !== undefined && unit.ownerId === playerId);
	if (units.length === 0) return { ok: false, error: "Select one of your units." };
	const removedUnitIds = new Set(units.map((unit) => unit.id));
	for (const unit of units) removeUnit(world, unit);
	for (const unit of Object.values(world.units)) {
		if ("targetId" in unit.command && removedUnitIds.has(unit.command.targetId))
			setUnitCommand(world, unit, { type: "idle" });
	}
	return { ok: true };
}

function commandSetRallyPoint(
	world: World,
	playerId: PlayerId,
	body: Extract<CommandPayload, { type: "setRallyPoint" }>,
): CommandResult {
	const building = getOwn(world.buildings, body.buildingId);
	if (
		!building ||
		building.ownerId !== playerId ||
		building.trainableUnits().length === 0
	)
		return { ok: false, error: "Select a production building." };
	const target = body.targetId
		? getOwn(world.buildings, body.targetId)
		: null;
	building.rallyPoint = target
		? centerOf(target)
		: {
				x: clamp(Number(body.x), 0, MAP_SIZE - 1),
				y: clamp(Number(body.y), 0, MAP_SIZE - 1),
			};
	building.rallyTargetId = target?.id ?? null;
	return { ok: true };
}

function commandTrain(
	world: World,
	playerId: PlayerId,
	body: Extract<CommandPayload, { type: "train" }>,
): CommandResult {
	const building = getOwn(world.buildings, body.buildingId);
	const unitDef = unitBehaviorFor(body.unitType);
	if (
		!building ||
		building.ownerId !== playerId ||
		!isComplete(building) ||
		!unitDef
	) {
		return { ok: false, error: "Cannot train there." };
	}
	if (!building.canTrain(body.unitType)) {
		return { ok: false, error: "Cannot train there." };
	}
	const player = getOwn(world.players, playerId);
	if (!player) return { ok: false, error: "Player not found." };
	if (player.population >= player.popCap)
		return { ok: false, error: "Population cap reached." };
	if (!building.queue)
		return { ok: false, error: "Selected building cannot train units." };
	if (building.queue.length >= 10)
		return { ok: false, error: "Training queue is full." };
	if (!spend(player, unitDef.cost))
		return { ok: false, error: "Not enough resources." };
	building.queue.push({
		unitType: body.unitType,
		remaining: unitDef.trainTime,
	} as BuildQueueItem);
	return { ok: true };
}

function forOwnUnits(
	world: World,
	playerId: PlayerId,
	unitIds: UnitId[] | undefined,
	fn: (unit: Unit, index: number) => void,
) {
	if (!Array.isArray(unitIds)) return;
	unitIds.forEach((unitId, index) => {
		const unit = getOwn(world.units, unitId);
		if (unit?.ownerId === playerId) fn(unit, index);
	});
}

function forOwnUnitClusters(
	world: World,
	playerId: PlayerId,
	unitIds: UnitId[] | undefined,
	fn: (
		unit: Unit,
		cluster: Unit[],
		index: number,
		reservedFormationTargets: Set<string>,
	) => void,
) {
	const units = ownUnits(world, playerId, unitIds);
	for (const cluster of spatialUnitClusters(units)) {
		const ordered = orderFormationCluster(cluster);
		const reservedFormationTargets = new Set<string>();
		ordered.forEach((unit, index) =>
			fn(unit, ordered, index, reservedFormationTargets),
		);
	}
}

function orderFormationCluster(cluster: Unit[]): Unit[] {
	const center = clusterCenter(cluster);
	return [...cluster].sort((a, b) => {
		const ay = a.y - center.y;
		const by = b.y - center.y;
		if (Math.abs(ay - by) > 0.001) return ay - by;
		return a.x - center.x - (b.x - center.x);
	});
}

function clusterCenter(cluster: Unit[]) {
	const total = cluster.reduce(
		(sum, unit) => ({ x: sum.x + unit.x, y: sum.y + unit.y }),
		{ x: 0, y: 0 },
	);
	return {
		x: total.x / Math.max(1, cluster.length),
		y: total.y / Math.max(1, cluster.length),
	};
}

function formationTargetForCluster(
	world: World,
	target: { x: number; y: number },
	cluster: Unit[],
	index: number,
	reserved: Set<string>,
) {
	const offset = formationSlotOffset(cluster.length, index);
	if (!offset) return undefined;
	return nearestWalkablePoint(
		world,
		{ x: target.x + offset.x, y: target.y + offset.y },
		reserved,
	);
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

function nearestCommandLandingPoint(
	world: World,
	point: { x: number; y: number },
	preferFrom: Vec2,
	reserved?: Set<string>,
) {
	return nearestWalkablePoint(world, point, reserved, {
		avoidClutter: false,
		preferFrom,
	});
}

function formationSpacing(count: number) {
	if (count >= 500) return 0.86;
	if (count >= 220) return 0.82;
	if (count >= 120) return 0.76;
	if (count >= 40) return 0.7;
	if (count >= 12) return 0.64;
	return 0.6;
}

function nearestWalkablePoint(
	world: World,
	point: { x: number; y: number },
	reserved?: Set<string>,
	options: { avoidClutter?: boolean; preferFrom?: Vec2 } = {},
) {
	const origin = {
		x: clamp(Math.floor(point.x), 0, MAP_SIZE - 1),
		y: clamp(Math.floor(point.y), 0, MAP_SIZE - 1),
	};
	let best: { x: number; y: number; score: number } | null = null;
	const avoidClutter = options.avoidClutter ?? true;
	for (let radius = 0; radius <= FORMATION_SEARCH_RADIUS; radius += 1) {
		for (let y = origin.y - radius; y <= origin.y + radius; y += 1) {
			for (let x = origin.x - radius; x <= origin.x + radius; x += 1) {
				if (
					Math.abs(x - origin.x) !== radius &&
					Math.abs(y - origin.y) !== radius
				)
					continue;
					if (!isAvailableFormationTile(world, x, y, reserved)) continue;
					const score = formationTileScore(world, point, x, y, avoidClutter, options.preferFrom);
					if (!best || score < best.score) best = { x, y, score };
				}
			}
			if (best && (!avoidClutter || formationTileClutter(world, best.x, best.y) === 0)) break;
		}
	if (best) return reserveFormationPoint(best.x, best.y, reserved);
	return {
		x: clamp(point.x, 0.2, MAP_SIZE - 0.2),
		y: clamp(point.y, 0.2, MAP_SIZE - 0.2),
	};
}

function formationTileScore(
	world: World,
	point: Vec2,
	x: number,
	y: number,
	avoidClutter: boolean,
	preferFrom?: Vec2,
) {
	return Math.hypot(x + 0.5 - point.x, y + 0.5 - point.y)
		+ (avoidClutter ? formationTileClutter(world, x, y) : 0)
		+ landingSidePenalty(point, x, y, preferFrom);
}

function landingSidePenalty(point: Vec2, x: number, y: number, preferFrom?: Vec2) {
	if (!preferFrom) return 0;
	const fromX = preferFrom.x - point.x;
	const fromY = preferFrom.y - point.y;
	const fromLength = Math.hypot(fromX, fromY);
	if (fromLength <= 0.001) return 0;
	const candidateX = x + 0.5 - point.x;
	const candidateY = y + 0.5 - point.y;
	const candidateLength = Math.hypot(candidateX, candidateY);
	if (candidateLength <= 0.001) return 0;
	const alignment = (fromX * candidateX + fromY * candidateY) / (fromLength * candidateLength);
	return alignment < 0 ? -alignment * 0.75 : 0;
}

function formationTileClutter(world: World, x: number, y: number) {
	let score = 0;
	for (let dy = -2; dy <= 2; dy += 1) {
		for (let dx = -2; dx <= 2; dx += 1) {
			if (dx === 0 && dy === 0) continue;
			if (!occupied(world, x + dx, y + dy)) continue;
			score += Math.abs(dx) <= 1 && Math.abs(dy) <= 1
				? FORMATION_ADJACENT_BLOCK_PENALTY
				: FORMATION_NEARBY_BLOCK_PENALTY;
		}
	}
	return score;
}

function isAvailableFormationTile(
	world: World,
	x: number,
	y: number,
	reserved?: Set<string>,
) {
	return isWalkable(world, x, y) && !reserved?.has(`${x},${y}`);
}

function reserveFormationPoint(x: number, y: number, reserved?: Set<string>) {
	reserved?.add(`${x},${y}`);
	return { x: x + 0.5, y: y + 0.5 };
}

function ownUnits(
	world: World,
	playerId: PlayerId,
	unitIds: UnitId[] | undefined,
): Unit[] {
	if (!Array.isArray(unitIds)) return [];
	return unitIds
		.map((unitId) => getOwn(world.units, unitId))
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

function stepBuilding(
	world: World,
	context: UnitSimulationContext,
	building: Building,
	dt: number,
) {
	if (building.cooldown !== undefined)
		building.cooldown = Math.max(0, building.cooldown - dt);
	if (building.attackFlash !== undefined)
		building.attackFlash = Math.max(0, (building.attackFlash || 0) - dt);
	if (!isComplete(building)) return;
	if (building.queue && building.queue.length > 0) {
		const current = building.queue[0];
		if (current) current.remaining -= dt;
		emitActionSound(world, "trainUnit", centerOf(building));
		if (current && current.remaining <= 0) {
			const item = building.queue.shift();
			if (!item) return;
			const unit = createUnit(
				world,
				building.ownerId,
				item.unitType,
				building.x + building.width + 0.4,
				building.y + building.height + 0.2,
			);
			if (building.rallyPoint) {
				assignRallyCommand(
					world,
					unit,
					building.rallyPoint,
					building.rallyTargetId ?? null,
				);
			}
		}
	}
	if (building.canAttack) {
		const target = context.nearestEnemy(building, building.attackRange);
		if (target && (building.cooldown ?? 0) <= 0) {
			damage(world, target, building.attack, building.ownerId);
			emitActionSound(world, "towerAttack", centerOf(building));
			building.cooldown = building.attackCooldown;
			building.attackFlash = 0.22;
		}
	}
}

function attackBlockingBuilding(
	world: World,
	zombie: Unit,
	targetPoint: { x: number; y: number },
) {
	const behavior = unitBehavior(zombie);
	const building = blockingBuildingToward(world, zombie, targetPoint);
	if (!building || zombie.cooldown > 0) return;
	damage(world, building, behavior.attack, ZOMBIE_OWNER_ID, zombie);
	zombie.cooldown = behavior.cooldown;
	zombie.attackFlash = 0.22;
}

function blockingBuildingToward(
	world: World,
	zombie: Unit,
	targetPoint: { x: number; y: number },
): Building | null {
	const dx = targetPoint.x - zombie.x;
	const dy = targetPoint.y - zombie.y;
	const length = Math.hypot(dx, dy) || 1;
	const step = 0.35;
	const blockingBuildings = blockingBuildingsByTile(world);
	for (
		let distanceToTarget = 0.65;
		distanceToTarget <= length;
		distanceToTarget += step
	) {
		const x = Math.floor(zombie.x + (dx / length) * distanceToTarget);
		const y = Math.floor(zombie.y + (dy / length) * distanceToTarget);
		const building = blockingBuildings.get(y * MAP_SIZE + x);
		if (building?.ownerId === zombie.ownerId) continue;
		if (building && building.hp > 0) return building;
	}
	return null;
}

function wallLikeBlockingBuildingToward(
	world: World,
	zombie: Unit,
	targetPoint: { x: number; y: number },
): Building | null {
	const building = blockingBuildingToward(world, zombie, targetPoint);
	if (!building) return null;
	return isWallLikeBlocker(world, building) ? building : null;
}

function isWallLikeBlocker(world: World, building: Building): boolean {
	if (building.type === "wall" || building.type === "gate") return true;
	if (building.width > 1 || building.height > 1) return true;
	const blockers = blockingBuildingsByTile(world);
	const x = Math.floor(building.x);
	const y = Math.floor(building.y);
	let connected = 0;
	for (const [dx, dy] of [
		[1, 0],
		[-1, 0],
		[0, 1],
		[0, -1],
	] as const) {
		const other = blockers.get((y + dy) * MAP_SIZE + x + dx);
		if (other && other.ownerId !== ZOMBIE_OWNER_ID && other.hp > 0)
			connected += 1;
	}
	return connected >= 2;
}

function blockingBuildingsByTile(world: World): Map<number, Building> {
	world._pathing ??= {
		occupancyVersion: 0,
		flowFields: new Map(),
		clearanceFields: new Map(),
		arrivalGroups: new Map(),
		pathRequestsThisTick: 0,
		lastRequestTick: -1,
	};
	const state = world._pathing;
	if (
		state.blockingBuildingsByTileVersion === state.occupancyVersion &&
		state.blockingBuildingsByTile
	)
		return state.blockingBuildingsByTile;

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
	state.blockingBuildingsByTile = buildings;
	state.blockingBuildingsByTileVersion = state.occupancyVersion;
	return buildings;
}

function stepResourceDecay(world: World, dt: number) {
	for (const resource of Object.values(world.resources)) {
		if (resource.stage !== "stump") continue;
		resource.decay = (resource.decay || 0) + dt;
		if (resource.decay >= STUMP_DECAY_SECONDS)
			removeResource(world, resource);
	}
}

function stepActionNoises(world: World, dt: number) {
	world.actionNoises = world.actionNoises.filter((noise) => {
		noise.remaining -= dt;
		return noise.remaining > 0;
	});
}

type ActionSoundKey = keyof typeof ACTION_SOUND_DEFS;

function emitActionSound(
	world: World,
	action: ActionSoundKey,
	point: { x: number; y: number },
) {
	const def = ACTION_SOUND_DEFS[action];
	const existing = world.actionNoises.find(
		(noise) => noise.action === action && distance(noise, point) <= 1.2,
	);
	if (existing) {
		existing.x = point.x;
		existing.y = point.y;
		existing.sound = Math.max(existing.sound, def.sound);
		existing.remaining = Math.max(existing.remaining, def.duration);
		return;
	}
	world.actionNoises.push({
		id: id("s"),
		action,
		x: point.x,
		y: point.y,
		sound: def.sound,
		remaining: def.duration,
	});
	while (world.actionNoises.length > MAX_ACTION_NOISES)
		world.actionNoises.shift();
}

function stepRuinDecay(world: World, dt: number) {
	for (const ruin of Object.values(world.ruins)) {
		ruin.age = (ruin.age || 0) + dt;
		if (ruin.age >= RUIN_DECAY_SECONDS) delete world.ruins[ruin.id];
	}
}

function stepCorpseDecay(world: World, dt: number) {
	for (const corpse of Object.values(world.corpses)) {
		corpse.remaining -= dt;
		if (corpse.remaining > 0) continue;
		delete world.corpses[corpse.id];
		createZombie(
			world,
			corpse.x + 0.5,
			corpse.y + 0.5,
			corpse.zombieSprite,
		);
	}
}

function weightedWorldSound(
	world: World,
): { point: { x: number; y: number }; strength: number } | null {
	const sources = buildSoundField(
		collectWorldSoundSources(world, ZOMBIE_OWNER_ID),
	)
		.filter((cell) => cell.worldStrength > 0)
		.map((cell) => ({
			point: { x: cell.x, y: cell.y },
			strength: cell.worldStrength ** 1.35,
		}));
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

function assignPostBuildGather(
	world: World,
	unit: Unit,
	resourceKind: ResourceType | null,
	builtFarm: Building | null = null,
) {
	if (builtFarm && unitBehavior(unit).canGather && isComplete(builtFarm)) {
		const resource = builtFarm.gatherResource;
		if (resource && buildingHasGathererCapacity(world, builtFarm, unit)) {
			setUnitCommand(world, unit, {
				type: "gather",
				targetId: builtFarm.id,
				resourceKind: resource,
				progress: 0,
				path: null,
			});
			return;
		}
	}
	if (resourceKind && unitBehavior(unit).canGather) {
		const next = findNextResource(world, unit, resourceKind);
		if (next) {
			setUnitCommand(world, unit, {
				type: "gather",
				targetId: next.id,
				resourceKind,
				progress: 0,
				path: null,
			});
			return;
		}
	}
	const nextBuild = findNextBuildSite(world, unit);
	if (!nextBuild) {
		setUnitCommand(world, unit, { type: "idle" });
		return;
	}
	nextBuild.builderIds = [
		...new Set([...(nextBuild.builderIds || []), unit.id]),
	];
	setUnitCommand(world, unit, {
		type: "build",
		targetId: nextBuild.id,
		path: null,
		resourceKind: nextBuild.depotGatherKind(),
		gatherBuiltFarm: nextBuild.shouldGatherAfterBuild,
	});
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

function findNextResource(
	world: World,
	unit: Unit,
	resourceKind: ResourceType | null,
): ResourceNode | Building | null {
	return findNextResourceNear(world, unit, resourceKind, unit.ownerId, unit);
}

type GatherReachabilityCache = {
	reachable: Map<string, boolean>;
	alternates: Map<string, ResourceNode | Building | null>;
};

type RankedGatherCandidate = {
	candidate: ResourceNode | Building;
	score: number;
};

function createGatherReachabilityCache(): GatherReachabilityCache {
	return {
		reachable: new Map(),
		alternates: new Map(),
	};
}

function reachableGatherResourceForUnit(
	world: World,
	unit: Unit,
	resource: ResourceNode | Building,
	cache?: GatherReachabilityCache,
	reservedTargets?: ReadonlyMap<string, number>,
): ResourceNode | Building | null {
	if (canReachGatherResource(world, unit, resource, cache)) return resource;
	return findAlternateResource(world, unit, gatherResource(resource), resource, cache, reservedTargets);
}

function findAlternateResource(
	world: World,
	unit: Unit,
	resourceKind: ResourceType,
	currentTarget: ResourceNode | Building,
	cache?: GatherReachabilityCache,
	reservedTargets?: ReadonlyMap<string, number>,
): ResourceNode | Building | null {
	const cacheKey = gatherAlternateCacheKey(unit, resourceKind, currentTarget);
	const cached = reservedTargets ? undefined : cache?.alternates.get(cacheKey);
	if (cached !== undefined) return cached;
	const depot = nearestDepot(world, unit.ownerId, resourceKind, unit);
	const currentPoint = isBuilding(currentTarget) ? centerOf(currentTarget) : currentTarget;
	const candidates = rankedGatherResourceCandidates(world, unit, resourceKind, currentTarget, currentPoint, depot, reservedTargets);
	for (const { candidate } of candidates) {
		if (canReachGatherResource(world, unit, candidate, cache)) {
			if (!reservedTargets) cache?.alternates.set(cacheKey, candidate);
			return candidate;
		}
	}
	if (!reservedTargets) cache?.alternates.set(cacheKey, null);
	return null;
}

function canReachGatherResource(world: World, unit: Unit, resource: ResourceNode | Building, cache?: GatherReachabilityCache) {
	const cacheKey = gatherReachabilityCacheKey(unit, resource);
	const cached = cache?.reachable.get(cacheKey);
	if (cached !== undefined) return cached;
	const point = isBuilding(resource) ? centerOf(resource) : resource;
	const range = isBuilding(resource) ? Math.max(resource.gatherRange, RESOURCE_GATHER_RANGE) : RESOURCE_GATHER_RANGE;
	const reachable = hasPathToInteractionRange(world, unit, point, range);
	cache?.reachable.set(cacheKey, reachable);
	return reachable;
}

function gatherReachabilityCacheKey(unit: Unit, resource: ResourceNode | Building) {
	const tile = {
		x: Math.floor(unit.x),
		y: Math.floor(unit.y),
	};
	return `${tile.x},${tile.y}:${resource.id}`;
}

function gatherAlternateCacheKey(unit: Unit, resourceKind: ResourceType, currentTarget: ResourceNode | Building) {
	const tile = {
		x: Math.floor(unit.x),
		y: Math.floor(unit.y),
	};
	return `${tile.x},${tile.y}:${resourceKind}:${currentTarget.id}`;
}

function findNextResourceNear(
	world: World,
	source: { x: number; y: number },
	resourceKind: ResourceType | null,
	playerId: PlayerId,
	assignedUnit: Unit | null = null,
	reservedTargets: ReadonlyMap<string, number> | null = null,
): ResourceNode | Building | null {
	if (!resourceKind) return null;
	const RANGE = 30;
	let best = null;
	let bestScore = Infinity;
	for (const r of Object.values(world.resources)) {
		if (r.amount <= 0 || r.resource !== resourceKind) continue;
		const d = distance(source, r);
		if (d > RANGE) continue;
		const score = d + gatherReservationPenalty(reservedTargets, r);
		if (score < bestScore) {
			best = r;
			bestScore = score;
		}
	}
	for (const b of Object.values(world.buildings)) {
		if (
			!b.canBeGatheredBy(playerId) ||
			b.gatherResource !== resourceKind ||
			b.gatherExhausted
		)
			continue;
		if (!buildingHasGathererCapacity(world, b, assignedUnit, reservedTargets)) continue;
		const d = distance(source, centerOf(b));
		if (d > RANGE) continue;
		const score = d + gatherReservationPenalty(reservedTargets, b);
		if (score < bestScore) {
			best = b;
			bestScore = score;
		}
	}
	return best;
}

function rankedGatherResourceCandidates(
	world: World,
	unit: Unit,
	resourceKind: ResourceType,
	currentTarget: ResourceNode | Building,
	currentPoint: Vec2,
	depot: Building | null,
	reservedTargets: ReadonlyMap<string, number> | undefined = undefined,
): RankedGatherCandidate[] {
	const ranked: RankedGatherCandidate[] = [];
	for (const resource of Object.values(world.resources)) {
		if (resource.id === currentTarget.id || resource.amount <= 0 || resource.resource !== resourceKind) continue;
		addRankedGatherCandidate(ranked, {
			candidate: resource,
			score: gatherRetargetScore(unit, resource, currentPoint, depot) + gatherReservationPenalty(reservedTargets, resource),
		});
	}
	for (const building of Object.values(world.buildings)) {
		if (
			building.id !== currentTarget.id &&
			building.canBeGatheredBy(unit.ownerId) &&
			building.gatherResource === resourceKind &&
			!building.gatherExhausted &&
			buildingHasGathererCapacity(world, building, unit, reservedTargets)
		) {
			addRankedGatherCandidate(ranked, {
				candidate: building,
				score: gatherRetargetScore(unit, centerOf(building), currentPoint, depot) + gatherReservationPenalty(reservedTargets, building),
			});
		}
	}
	return ranked.sort((a, b) => a.score - b.score);
}

function reserveGatherTarget(reservedTargets: Map<string, number>, target: ResourceNode | Building) {
	reservedTargets.set(target.id, (reservedTargets.get(target.id) || 0) + 1);
}

function gatherReservationPenalty(
	reservedTargets: ReadonlyMap<string, number> | null | undefined,
	target: ResourceNode | Building,
) {
	return (reservedTargets?.get(target.id) || 0) * GATHER_ASSIGNMENT_SPREAD_PENALTY;
}

function gatherRetargetScore(unit: Unit, point: Vec2, currentPoint: Vec2, depot: Building | null) {
	const depotScore = depot ? distance(centerOf(depot), point) * 0.45 : 0;
	return distance(unit, point) + distance(currentPoint, point) * 0.65 + depotScore;
}

function addRankedGatherCandidate(ranked: RankedGatherCandidate[], candidate: RankedGatherCandidate) {
	if (ranked.length < GATHER_RETARGET_CANDIDATE_LIMIT) {
		ranked.push(candidate);
		return;
	}
	let worstIndex = 0;
	let worstScore = ranked[0]!.score;
	for (let index = 1; index < ranked.length; index += 1) {
		if (ranked[index]!.score > worstScore) {
			worstIndex = index;
			worstScore = ranked[index]!.score;
		}
	}
	if (candidate.score < worstScore) ranked[worstIndex] = candidate;
}

function assignRallyCommand(
	world: World,
	unit: Unit,
	rallyPoint: Vec2,
	targetId: EntityId | null,
) {
	const target = targetId ? world.buildings[targetId as BuildingId] : null;
	if (target && assignRallyTargetCommand(world, unit, target)) return;
	const depot = depotAtPoint(world, unit.ownerId, rallyPoint);
	const resourceKind =
		depot?.depotGatherKind() || depot?.gatherResource || null;
	if (resourceKind && unitBehavior(unit).canGather) {
		const resource = findNextResourceNear(
			world,
			depot ? centerOf(depot) : rallyPoint,
			resourceKind,
			unit.ownerId,
			unit,
		);
		if (resource) {
			setUnitCommand(world, unit, {
				type: "gather",
				targetId: resource.id,
				resourceKind,
				progress: 0,
				path: null,
			});
			return;
		}
	}
	setUnitCommand(world, unit, rallyMoveCommand(world, unit, rallyPoint));
}

/** Builds a rally move command whose crowd reflects nearby gathered units so they settle and spread instead of contending for one tile. */
function rallyMoveCommand(
	world: World,
	unit: Unit,
	point: Vec2,
): Extract<UnitCommand, { type: "move" }> {
	return {
		type: "move",
		...point,
		path: null,
		pathCrowd: rallyCrowd(world, unit.ownerId, point),
	};
}

function rallyCrowd(world: World, ownerId: PlayerId, point: Vec2): number {
	let crowd = 0;
	for (const other of Object.values(world.units)) {
		if (other.ownerId !== ownerId || other.type === "zombie") continue;
		if (distance(other, point) <= RALLY_GATHER_RADIUS) crowd += 1;
	}
	return Math.max(1, crowd);
}

function assignRallyTargetCommand(world: World, unit: Unit, target: Building) {
	if (
		target.ownerId === unit.ownerId &&
		target.hp < target.maxHp &&
		unitBehavior(unit).canBuild
	) {
		if (isComplete(target)) {
			const player = world.players[unit.ownerId];
			if (player && spend(player, repairCost(target)))
				target.repairPaidUntilHp = target.maxHp;
			else return false;
		}
		target.builderIds = [
			...new Set([...(target.builderIds || []), unit.id]),
		];
		setUnitCommand(world, unit, {
			type: "build",
			targetId: target.id,
			path: null,
			resourceKind: target.depotGatherKind(),
			gatherBuiltFarm: target.shouldGatherAfterBuild,
		});
		return true;
	}
	const resourceKind = target.depotGatherKind() || target.gatherResource;
	if (
		target.ownerId === unit.ownerId &&
		resourceKind &&
		unitBehavior(unit).canGather
	) {
		const resource = target.depotGatherKind()
			? findNextResourceNear(
					world,
					centerOf(target),
					resourceKind,
					unit.ownerId,
					unit,
				)
			: target.canBeGatheredBy(unit.ownerId) &&
				  !target.gatherExhausted &&
				  buildingHasGathererCapacity(world, target, unit)
				? target
				: null;
		if (resource) {
			setUnitCommand(world, unit, {
				type: "gather",
				targetId: resource.id,
				resourceKind,
				progress: 0,
				path: null,
			});
			return true;
		}
	}
	setUnitCommand(
		world,
		unit,
		rallyMoveCommand(world, unit, centerOf(target)),
	);
	return true;
}

function depotAtPoint(
	world: World,
	playerId: PlayerId,
	point: Vec2,
): Building | null {
	return (
		Object.values(world.buildings).find(
			(building) =>
				building.ownerId === playerId &&
				isComplete(building) &&
				(building.depotGatherKind() || building.gatherResource) &&
				pointInsideEntity(
					Math.floor(point.x),
					Math.floor(point.y),
					building,
				),
		) || null
	);
}

function nearestDepot(
	world: World,
	ownerId: PlayerId,
	resource: ResourceType,
	source: { x: number; y: number },
) {
	let best = null;
	let bestDist = Infinity;
	for (const building of Object.values(world.buildings)) {
		if (
			building.ownerId !== ownerId ||
			!isComplete(building) ||
			!building.canAcceptResource(resource)
		)
			continue;
		const d = distance(source, centerOf(building));
		if (d < bestDist) {
			best = building;
			bestDist = d;
		}
	}
	return best;
}

function gatherableBuilding(
	building: Building | undefined,
	playerId: PlayerId,
): Building | null {
	if (!building?.canBeGatheredBy(playerId)) return null;
	return building;
}

function buildingHasGathererCapacity(
	world: World,
	building: Building,
	assignedUnit: Unit | null = null,
	reservedTargets: ReadonlyMap<string, number> | null = null,
) {
	return building.hasGathererCapacity(
		gathererCountFor(world, building, assignedUnit) + (reservedTargets?.get(building.id) || 0),
	);
}

function gathererCountFor(
	world: World,
	building: Building,
	assignedUnit: Unit | null,
) {
	let count = 0;
	for (const unit of Object.values(world.units)) {
		if (unit.id === assignedUnit?.id || unit.ownerId !== building.ownerId)
			continue;
		if (
			unit.command.type === "gather" &&
			unit.command.targetId === building.id
		)
			count += 1;
	}
	return count;
}

function maybeAutoReplenishBuilding(world: World, building: Building) {
	const player = world.players[building.ownerId];
	if (!player) return;
	building.maybeReplenish(
		(cost) => spend(player, cost),
		player.autoReplenishFarms,
	);
}

function replenishFarm(world: World, building: Building): boolean {
	const player = world.players[building.ownerId];
	if (!player) return false;
	return building.maybeReplenish((cost) => spend(player, cost), true);
}

function unitTargetGridsByOwner(
	world: World,
): Map<PlayerId, SpatialGrid<Unit>> {
	const unitsByOwner = new Map<PlayerId, Unit[]>();
	for (const unit of Object.values(world.units)) {
		if (unit.hp <= 0) continue;
		const units = unitsByOwner.get(unit.ownerId);
		if (units) units.push(unit);
		else unitsByOwner.set(unit.ownerId, [unit]);
	}
	return new Map(
		[...unitsByOwner.entries()].map(([ownerId, units]) => [
			ownerId,
			new SpatialGrid(units, TARGET_UNIT_GRID_CELL_SIZE),
		]),
	);
}

function nearestEnemy(
	world: World,
	unitGridsByOwner: Map<PlayerId, SpatialGrid<Unit>>,
	buildingGrid: SpatialGrid<Building>,
	source: Unit | Building,
	range: number,
) {
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
	for (const entry of buildingGrid.nearby(sourceCenter, range)) {
		const building = entry.item;
		if (building.ownerId === source.ownerId || building.hp <= 0) continue;
		if (world.buildings[building.id] !== building) continue;
		const d = distance(sourceCenter, centerOf(building));
		if (d < bestDist) {
			best = building;
			bestDist = d;
		}
	}
	return best;
}

function nearestTargetUnit(
	world: World,
	targetUnitGrid: SpatialGrid<Unit>,
	source: { x: number; y: number },
	range: number,
) {
	let best: Unit | null = null;
	let bestDist = range;
	const sourceCenter = centerOf(source);
	targetUnitGrid.forNearby(sourceCenter, range, (entry) => {
		const unit = entry.item;
		if (
			unit.hp <= 0 ||
			unit.type === "zombie" ||
			world.units[unit.id] !== unit
		)
			return;
		const d = distance(sourceCenter, centerOf(unit));
		if (d < bestDist) {
			best = unit;
			bestDist = d;
		}
	});
	return best;
}

function nearestTargetBuilding(
	world: World,
	buildingGrid: SpatialGrid<Building>,
	source: Unit,
	range: number,
) {
	let best: Building | null = null;
	let bestDist = range;
	const sourceCenter = centerOf(source);
	buildingGrid.forNearby(sourceCenter, range, (entry) => {
		const building = entry.item;
		if (
			building.ownerId === source.ownerId ||
			building.hp <= 0 ||
			world.buildings[building.id] !== building
		)
			return;
		const d = distance(sourceCenter, centerOf(building));
		if (d < bestDist) {
			best = building;
			bestDist = d;
		}
	});
	return best;
}

function isBuilding(
	entity: ResourceNode | Building | null | undefined,
): entity is Building {
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

function damage(
	world: World,
	target: Unit | Building | Corpse,
	amount: number,
	attackerId: PlayerId,
	attacker?: Unit,
) {
	if (target.kind === "corpse") {
		target.hp -= amount;
		if (target.hp <= 0) delete world.corpses[target.id];
		return;
	}
	if (target.kind === "building" && target.invincible) return;
	target.hp -= amount;
	if (target.kind === "building" && target.repairPaidUntilHp !== undefined) {
		target.repairPaidUntilHp = Math.min(
			target.repairPaidUntilHp,
			target.hp,
		);
	}
	if (target.hp > 0) {
		if (target.kind === "unit" && attacker)
			unitBehavior(target).onAttacked(
				{
					setCommand: (unit, command) =>
						setUnitCommand(world, unit, command),
				},
				target,
				attacker,
			);
		return;
	}
	if (target.kind === "building") {
		world.players[target.ownerId]?.statistics?.recordBuildingLost();
		if (attackerId !== target.ownerId)
			world.players[attackerId]?.statistics?.recordBuildingRazed();
		emitActionSound(world, "buildingDestroyed", centerOf(target));
		createRuin(world, target);
		removeBuilding(world, target);
		if (target.type === "townCenter")
			defeatPlayer(world, target.ownerId, attackerId);
	} else {
		const shouldTurn =
			attackerId === ZOMBIE_OWNER_ID &&
			target.ownerId !== ZOMBIE_OWNER_ID;
		if (attackerId !== target.ownerId)
			world.players[attackerId]?.statistics?.recordUnitKilled();
		removeUnit(world, target, true);
		if (shouldTurn) createCorpse(world, target);
	}
}

function defeatPlayer(world: World, playerId: PlayerId, attackerId: PlayerId) {
	const player = world.players[playerId];
	if (!player || player.defeated) return;
	player.defeated = true;
	player.statistics?.finish();
	const attacker = world.players[attackerId];
	notice(
		world,
		`${player.name}'s town center was destroyed${attacker ? ` by ${attacker.name}` : ""}.`,
	);
	destroyPlayerStuff(world, playerId);
}

function destroyPlayerStuff(world: World, playerId: PlayerId) {
	for (const unit of Object.values(world.units)) {
		if (unit.ownerId === playerId) removeUnit(world, unit);
	}
	for (const building of Object.values(world.buildings)) {
		if (building.ownerId === playerId) {
			createRuin(world, building);
			removeBuilding(world, building);
		}
	}
}

function canPlace(
	world: World,
	x: number,
	y: number,
	width: number,
	height: number,
	ignoredBuilding: Building | null = null,
): boolean {
	if (x < 0 || y < 0 || x + width > MAP_SIZE || y + height > MAP_SIZE)
		return false;
	for (const building of Object.values(world.buildings)) {
		if (building === ignoredBuilding) continue;
		if (rectsOverlap({ x, y, width, height }, building)) return false;
	}
	for (let dy = 0; dy < height; dy += 1) {
		for (let dx = 0; dx < width; dx += 1) {
			if (
				ignoredBuilding &&
				pointInsideEntity(x + dx, y + dy, ignoredBuilding)
			)
				continue;
			if (occupied(world, x + dx, y + dy)) return false;
		}
	}
	return true;
}

function centerOf(entity: Footprint) {
	return {
		x: entity.x + (footprintWidth(entity) - 1) / 2,
		y: entity.y + (footprintHeight(entity) - 1) / 2,
	};
}

function spend(
	player: Player,
	cost: Partial<Record<ResourceType, number>> = {},
): boolean {
	const entries = Object.entries(cost) as [ResourceType, number][];
	for (const [resource, amount] of entries) {
		if ((player.resources[resource] || 0) < amount) return false;
	}
	for (const [resource, amount] of entries)
		player.resources[resource] -= amount;
	return true;
}

function netCost(
	cost: Partial<Record<ResourceType, number>>,
	refund: Partial<Record<ResourceType, number>>,
) {
	const result: Partial<Record<ResourceType, number>> = { ...cost };
	for (const [resource, amount] of Object.entries(refund) as [
		ResourceType,
		number,
	][]) {
		result[resource] = Math.max(0, (result[resource] || 0) - amount);
	}
	return result;
}

function repairCost(building: Building) {
	const paidUntilHp = building.repairPaidUntilHp ?? building.hp;
	const missingHealthRatio =
		Math.max(0, building.maxHp - Math.max(building.hp, paidUntilHp)) /
		building.maxHp;
	return Object.fromEntries(
		Object.entries(building.cost).map(([resource, amount]) => [
			resource,
			Math.ceil(amount * missingHealthRatio),
		]),
	) as Partial<Record<ResourceType, number>>;
}

function recalcPlayer(world: World, playerId: PlayerId) {
	const player = world.players[playerId];
	if (!player) return;
	player.workerCounts ??= createEmptyWorkerCounts();
	const units = Object.values(world.units).filter(
		(unit) => unit.ownerId === playerId,
	);
	const buildings = Object.values(world.buildings).filter(
		(building) => building.ownerId === playerId,
	);
	player.population = units.length;
	player.popCap =
		4 +
		buildings.filter(isComplete).reduce((sum, building) => {
			return sum + building.populationCapacity;
		}, 0);
	const unitScore = units.reduce(
		(sum, unit) => sum + unitBehavior(unit).score,
		0,
	);
	const buildingScore = buildings
		.filter(isComplete)
		.reduce((sum, building) => sum + building.score, 0);
	const score = player.defeated ? 0 : unitScore + buildingScore;
	if (player.score !== score) {
		world._globalLeaderboardDirtyPlayerIds ??= {};
		world._globalLeaderboardDirtyPlayerIds[player.id] = true;
	}
	player.score = score;
	player.statistics?.recordScore(score);
}

function isComplete(building: Building): boolean {
	return building.isComplete();
}

function updateLeaderboard(world: World) {
	const now = Date.now();
	const leaders = Object.values(world.players)
		.filter((player) => !player.defeated)
		.sort((a, b) => b.score - a.score);
	const leader = leaders[0] ?? null;
	if (!leader) {
		commitFirstPlaceDuration(world, now);
		delete world.firstPlacePlayerId;
		delete world.firstPlaceSince;
		world.leaderboard = [];
		return;
	}
	if (world.firstPlacePlayerId !== leader.id) {
		commitFirstPlaceDuration(world, now);
		world.firstPlacePlayerId = leader.id;
		world.firstPlaceSince = now;
	}
	world.leaderboard = leaders.map((player) => ({
		id: player.id,
		name: player.name,
		color: player.color,
		score: player.score,
		defeated: player.defeated,
		joinedAt: player.joinedAt,
		firstPlaceSince:
			player.id === world.firstPlacePlayerId
				? (world.firstPlaceSince ?? null)
				: null,
	}));
}

export function firstPlaceDurationMs(
	world: World,
	playerId: PlayerId,
	now = Date.now(),
) {
	let duration = world.firstPlaceDurations?.[playerId] ?? 0;
	if (world.firstPlacePlayerId === playerId && world.firstPlaceSince) {
		duration += Math.max(0, now - world.firstPlaceSince);
	}
	return duration;
}

function commitFirstPlaceDuration(world: World, now = Date.now()) {
	if (!world.firstPlacePlayerId || !world.firstPlaceSince) return;
	world.firstPlaceDurations ??= {};
	const elapsed = Math.max(0, now - world.firstPlaceSince);
	world.firstPlaceDurations[world.firstPlacePlayerId] =
		(world.firstPlaceDurations[world.firstPlacePlayerId] ?? 0) + elapsed;
}

export function addNotice(world: World, text: string) {
	world.notices.push({ id: id("n"), text, at: Date.now() });
}

function notice(world: World, text: string) {
	addNotice(world, text);
}

function normalizeColor(value: unknown): string | null {
	if (typeof value !== "string") return null;
	return /^#[0-9a-f]{6}$/i.test(value) ? value : null;
}

function unitBehavior(unit: Unit) {
	return unitBehaviorFor(unit.type);
}
