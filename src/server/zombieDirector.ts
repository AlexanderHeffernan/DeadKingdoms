import { MAP_SIZE } from "../shared/config.js";
import type { Building, Unit, Vec2, World, ZombieHorde } from "../shared/types.js";
import { unitBehaviorFor } from "../shared/unitRegistry.js";
import { id } from "./id.js";
import { clamp, distance } from "./math.js";
import { ZOMBIE_OWNER_ID } from "./zombieSpawning.js";
import { SpatialGrid } from "./utils/SpatialGrid.js";

const HORDE_CELL_SIZE = 8;
const HORDE_JOIN_RADIUS = 7.5;
const HORDE_MERGE_PADDING = 5;
const HORDE_TARGET_MEMORY_SECONDS = 10;
const HORDE_WANDER_RADIUS = 18;
const HORDE_RETARGET_TICKS = 8;
const HORDE_MIN_RADIUS = 3;
const HORDE_MAX_RADIUS = 18;
const HORDE_SOUND_BASE_RANGE = 14;
const HORDE_SOUND_RANGE_PER_STRENGTH = 4.5;
const ZOMBIE_FORMATION_JITTER = 1.4;

type SoundSource = Vec2 & { strength: number };

export function stepZombieDirector(world: World, dt: number) {
	const zombies = Object.values(world.units).filter((unit) => unit.ownerId === ZOMBIE_OWNER_ID && unit.hp > 0);
	if (zombies.length === 0) {
		world._zombieHordes = {};
		return;
	}

	const shouldRebuild = !world._zombieHordes || world.tick % HORDE_RETARGET_TICKS === 0;
	if (shouldRebuild) world._zombieHordes = buildHordes(world, zombies);
	else refreshHordes(world);

	const hordes = Object.values(world._zombieHordes || {});
	const soundSources = collectSoundSources(world);
	const targetUnits = Object.values(world.units).filter((unit) => unit.ownerId !== ZOMBIE_OWNER_ID && unit.hp > 0);

	for (const horde of hordes) {
		horde.targetMemory = Math.max(0, horde.targetMemory - dt);
		const directTarget = nearestPoint([...targetUnits, ...Object.values(world.buildings).filter((building) => building.hp > 0)], horde.center, horde.radius + 8);
		const soundTarget = directTarget ? null : loudestSound(soundSources, horde.center);

		if (directTarget) {
			horde.target = centerOf(directTarget);
			horde.targetMemory = HORDE_TARGET_MEMORY_SECONDS;
			horde.wanderTarget = null;
		} else if (soundTarget) {
			horde.target = soundTarget;
			horde.targetMemory = HORDE_TARGET_MEMORY_SECONDS;
			horde.wanderTarget = null;
		} else if (horde.targetMemory <= 0) {
			horde.target = null;
			horde.wanderTarget = horde.wanderTarget && distance(horde.center, horde.wanderTarget) > 2 ? horde.wanderTarget : chooseWanderTarget(horde.center);
		}

		assignZombieGoals(world, horde);
	}
}

function buildHordes(world: World, zombies: Unit[]): Record<string, ZombieHorde> {
	const grid = new SpatialGrid(zombies, HORDE_CELL_SIZE);
	const visited = new Set<string>();
	const previous = world._zombieHordes || {};
	const hordes: Record<string, ZombieHorde> = {};

	for (const zombie of zombies) {
		if (visited.has(zombie.id)) continue;
		const members = collectConnectedZombies(grid, zombie, visited);
		const previousHorde = bestPreviousHorde(previous, members);
		const horde = makeHorde(previousHorde?.id || id("h"), members, previousHorde || null);
		hordes[horde.id] = horde;
		for (const memberId of horde.memberIds) {
			const member = world.units[memberId];
			if (!member) continue;
			member.hordeId = horde.id;
			member.hordeOffset = member.hordeOffset || randomOffset(horde.radius);
		}
	}

	return hordes;
}

function refreshHordes(world: World) {
	for (const horde of Object.values(world._zombieHordes || {})) {
		const members = horde.memberIds.map((memberId) => world.units[memberId]).filter((unit): unit is Unit => !!unit && unit.hp > 0);
		horde.memberIds = members.map((unit) => unit.id);
		if (members.length === 0) continue;
		horde.center = averagePoint(members);
		horde.radius = clamp(Math.sqrt(members.length) * 1.4 + HORDE_MERGE_PADDING, HORDE_MIN_RADIUS, HORDE_MAX_RADIUS);
	}
}

function collectConnectedZombies(grid: SpatialGrid<Unit>, seed: Unit, visited: Set<string>): Unit[] {
	const members: Unit[] = [];
	const queue = [seed];
	visited.add(seed.id);

	for (let i = 0; i < queue.length; i += 1) {
		const zombie = queue[i]!;
		members.push(zombie);
		for (const entry of grid.nearby(zombie, HORDE_JOIN_RADIUS)) {
			const other = entry.item;
			if (visited.has(other.id)) continue;
			if (distance(zombie, other) > HORDE_JOIN_RADIUS) continue;
			visited.add(other.id);
			queue.push(other);
		}
	}

	return members;
}

function bestPreviousHorde(previous: Record<string, ZombieHorde>, members: Unit[]) {
	const counts = new Map<string, number>();
	for (const member of members) {
		if (!member.hordeId || !previous[member.hordeId]) continue;
		counts.set(member.hordeId, (counts.get(member.hordeId) || 0) + 1);
	}
	let best: ZombieHorde | null = null;
	let bestCount = 0;
	for (const [hordeId, count] of counts) {
		if (count <= bestCount) continue;
		best = previous[hordeId]!;
		bestCount = count;
	}
	return best;
}

function makeHorde(idValue: string, members: Unit[], previous: ZombieHorde | null): ZombieHorde {
	const center = averagePoint(members);
	const radius = clamp(Math.sqrt(members.length) * 1.4 + HORDE_MERGE_PADDING, HORDE_MIN_RADIUS, HORDE_MAX_RADIUS);
	return {
		id: idValue,
		memberIds: members.map((unit) => unit.id),
		center,
		radius,
		target: previous?.target || null,
		targetMemory: previous?.targetMemory || 0,
		wanderTarget: previous?.wanderTarget || null,
	};
}

function assignZombieGoals(world: World, horde: ZombieHorde) {
	const target = horde.target || horde.wanderTarget;
	if (!target) return;

	for (const memberId of horde.memberIds) {
		const zombie = world.units[memberId];
		if (!zombie) continue;
		const offset = zombie.hordeOffset || randomOffset(horde.radius);
		zombie.hordeOffset = offset;
		zombie.soundTarget = {
			x: clamp(target.x + offset.x * ZOMBIE_FORMATION_JITTER, 0.5, MAP_SIZE - 0.5),
			y: clamp(target.y + offset.y * ZOMBIE_FORMATION_JITTER, 0.5, MAP_SIZE - 0.5),
		};
		zombie.wanderTarget = null;
	}
}

function collectSoundSources(world: World): SoundSource[] {
	const sources: SoundSource[] = [];
	for (const unit of Object.values(world.units)) {
		if (unit.ownerId === ZOMBIE_OWNER_ID || unit.hp <= 0) continue;
		const strength = unitBehaviorFor(unit.type).soundLevel();
		if (strength > 0) sources.push({ x: unit.x, y: unit.y, strength });
	}
	for (const building of Object.values(world.buildings)) {
		const strength = building.soundLevel();
		if (strength > 0) sources.push({ ...centerOf(building), strength });
	}
	for (const noise of world.actionNoises) {
		if (noise.sound > 0) sources.push({ x: noise.x, y: noise.y, strength: noise.sound });
	}
	return sources;
}

function loudestSound(sources: SoundSource[], point: Vec2): Vec2 | null {
	let best: SoundSource | null = null;
	let bestScore = 0;
	for (const source of sources) {
		const d = distance(point, source);
		const range = HORDE_SOUND_BASE_RANGE + source.strength * HORDE_SOUND_RANGE_PER_STRENGTH;
		if (d > range) continue;
		const score = source.strength / Math.max(4, d * d);
		if (score > bestScore) {
			best = source;
			bestScore = score;
		}
	}
	return best ? { x: best.x, y: best.y } : null;
}

function nearestPoint<T extends Unit | Building>(entities: T[], point: Vec2, range: number): T | null {
	let best: T | null = null;
	let bestDist = range;
	for (const entity of entities) {
		const d = distance(point, centerOf(entity));
		if (d < bestDist) {
			best = entity;
			bestDist = d;
		}
	}
	return best;
}

function chooseWanderTarget(center: Vec2): Vec2 {
	const angle = Math.random() * Math.PI * 2;
	const radius = 4 + Math.random() * HORDE_WANDER_RADIUS;
	return {
		x: clamp(center.x + Math.cos(angle) * radius, 0.5, MAP_SIZE - 0.5),
		y: clamp(center.y + Math.sin(angle) * radius, 0.5, MAP_SIZE - 0.5),
	};
}

function randomOffset(radius: number): Vec2 {
	const angle = Math.random() * Math.PI * 2;
	const distanceOut = Math.random() * Math.max(1, radius * 0.35);
	return { x: Math.cos(angle) * distanceOut, y: Math.sin(angle) * distanceOut };
}

function averagePoint(units: Unit[]): Vec2 {
	const total = units.reduce((sum, unit) => ({ x: sum.x + unit.x, y: sum.y + unit.y }), { x: 0, y: 0 });
	return { x: total.x / units.length, y: total.y / units.length };
}

function centerOf(entity: { x: number; y: number; size?: number }) {
	const offset = entity.size ? (entity.size - 1) / 2 : 0;
	return { x: entity.x + offset, y: entity.y + offset };
}
