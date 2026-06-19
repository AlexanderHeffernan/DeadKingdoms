import { MAP_SIZE } from "../shared/config.js";
import type { Building, Unit, Vec2 } from "../shared/types.js";
import { clamp } from "./math.js";
import type { SpawnContext, SpawnPolicy } from "./spawning.js";

export const ZOMBIE_OWNER_ID = "zombies" as Unit["ownerId"];

const ZOMBIE_BASE_CAP = 140;
const ZOMBIES_PER_ACTIVE_PLAYER = 80;
const ZOMBIES_PER_ACTIVE_POPULATION = 2;
const ZOMBIE_SPAWN_INTERVAL_SECONDS = 7;
const ZOMBIE_SPAWN_BATCH_MIN = 2;
const ZOMBIE_SPAWN_BATCH_MAX = 5;
const ZOMBIE_SAFE_RADIUS = 44;
const ZOMBIE_SPAWN_SIGHT_BUFFER = 4;

export type ZombieSpawnContext = SpawnContext & {
	createZombie(point: Vec2): Unit;
	isWalkable(x: number, y: number): boolean;
	centerOf(entity: { x: number; y: number; size?: number }): Vec2;
	distance(a: Vec2, b: Vec2): number;
	weightedWorldSound(): { point: Vec2; strength: number } | null;
	unitVision(unit: Unit): number;
	randomInt(min: number, max: number): number;
};

export const zombieSpawnPolicy: SpawnPolicy<ZombieSpawnContext> = {
	key: "zombie",
	initialDelaySeconds: ZOMBIE_SPAWN_INTERVAL_SECONDS,
	nextDelaySeconds: () => ZOMBIE_SPAWN_INTERVAL_SECONDS,
	canSpawn: hasActivePlayers,
	currentCount: countZombies,
	cap: zombieCap,
	batchSize: zombieBatchSize,
	chooseSpawnPoint: chooseZombieSpawn,
	spawn: (context, point) => {
		context.createZombie(point);
	},
};

function hasActivePlayers(context: ZombieSpawnContext) {
	return Object.values(context.world.players).some((player) => !player.defeated);
}

function countZombies(context: ZombieSpawnContext) {
	return Object.values(context.world.units).filter((unit) => unit.type === "zombie").length;
}

function zombieCap(context: ZombieSpawnContext) {
	const activePlayers = Object.values(context.world.players).filter((player) => !player.defeated);
	const activePopulation = activePlayers.reduce((sum, player) => sum + player.population, 0);
	return ZOMBIE_BASE_CAP + activePlayers.length * ZOMBIES_PER_ACTIVE_PLAYER + activePopulation * ZOMBIES_PER_ACTIVE_POPULATION;
}

function zombieBatchSize(context: ZombieSpawnContext, remainingCapacity: number) {
	return Math.min(context.randomInt(ZOMBIE_SPAWN_BATCH_MIN, ZOMBIE_SPAWN_BATCH_MAX), remainingCapacity);
}

function chooseZombieSpawn(context: ZombieSpawnContext): Vec2 | null {
	const noiseTarget = context.weightedWorldSound();
	for (let attempt = 0; attempt < 180; attempt += 1) {
		const candidate = randomZombieSpawnPoint(context, noiseTarget?.point || null);
		if (canSpawnZombieAt(context, candidate.x, candidate.y)) return candidate;
	}
	return null;
}

function randomZombieSpawnPoint(context: ZombieSpawnContext, target: Vec2 | null) {
	if (target && Math.random() < 0.2) {
		const angle = Math.random() * Math.PI * 2;
		const radius = 30 + Math.random() * 120;
		return {
			x: clamp(target.x + Math.cos(angle) * radius, 1, MAP_SIZE - 2),
			y: clamp(target.y + Math.sin(angle) * radius, 1, MAP_SIZE - 2),
		};
	}
	return {
		x: context.randomInt(1, MAP_SIZE - 2),
		y: context.randomInt(1, MAP_SIZE - 2),
	};
}

function canSpawnZombieAt(context: ZombieSpawnContext, x: number, y: number): boolean {
	if (!context.isWalkable(Math.floor(x), Math.floor(y))) return false;
	for (const building of Object.values(context.world.buildings)) {
		if (building.type !== "townCenter") continue;
		if (context.distance({ x, y }, context.centerOf(building)) < ZOMBIE_SAFE_RADIUS) return false;
	}
	return !isInAnyPlayerSight(context, x, y);
}

function isInAnyPlayerSight(context: ZombieSpawnContext, x: number, y: number): boolean {
	for (const player of Object.values(context.world.players)) {
		if (player.defeated) continue;
		if (isPointInPlayerUnitSight(context, player.id, x, y)) return true;
		if (isPointInPlayerBuildingSight(context, player.id, x, y)) return true;
	}
	return false;
}

function isPointInPlayerUnitSight(context: ZombieSpawnContext, playerId: Unit["ownerId"], x: number, y: number) {
	for (const unit of Object.values(context.world.units)) {
		if (unit.ownerId !== playerId) continue;
		if (context.distance({ x, y }, unit) <= context.unitVision(unit) + ZOMBIE_SPAWN_SIGHT_BUFFER) return true;
	}
	return false;
}

function isPointInPlayerBuildingSight(context: ZombieSpawnContext, playerId: Building["ownerId"], x: number, y: number) {
	for (const building of Object.values(context.world.buildings)) {
		if (building.ownerId !== playerId) continue;
		if (context.distance({ x, y }, context.centerOf(building)) <= (building.vision || 5) + ZOMBIE_SPAWN_SIGHT_BUFFER) return true;
	}
	return false;
}
