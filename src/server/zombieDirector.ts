import { MAP_SIZE } from "../shared/config.js";
import type { Building, Unit, Vec2, World, ZombieHorde } from "../shared/types.js";
import {
	SOUND_FIELD_CELL_SIZE,
	SOUND_FIELD_MAX_STRENGTH,
	SOUND_FIELD_MIN_SPREAD_STRENGTH,
	SOUND_FIELD_OVERFLOW_DECAY,
	SOUND_FIELD_OVERFLOW_KNEE,
	buildSoundField,
	collectWorldSoundSources,
	soundFieldCellAt,
	type SoundFieldSource,
	type SoundFieldCell,
} from "../shared/soundField.js";
import type { ActionNoise } from "../shared/types.js";
import { id } from "./id.js";
import { clamp, distance } from "./math.js";
import { isWalkable, nearestWalkablePointAround } from "./pathing.js";
import { ZOMBIE_OWNER_ID } from "./zombieSpawning.js";
import { SpatialGrid } from "./utils/SpatialGrid.js";

const HORDE_CELL_SIZE = 4;
const HORDE_JOIN_RADIUS = 3;
const HORDE_COHORT_RADIUS = 8;
const HORDE_MERGE_PADDING = 2.5;
const HORDE_TARGET_MEMORY_SECONDS = 10;
const HORDE_RETARGET_TICKS = 8;
const HORDE_MIN_RADIUS = 1.5;
const HORDE_MAX_RADIUS = 9;
const SOUND_MEMORY_DECAY_PER_SECOND = 0.05;
const SOUND_MEMORY_MIN_SIGNIFICANCE = 0.01;
const SOUND_MEMORY_FOLLOW_DISTANCE = 18;
const SOUND_MEMORY_REACHED_DISTANCE = 1.5;
const HORDE_TARGET_REACHED_DISTANCE = 1.2;
const HORDE_WANDER_MIN_DISTANCE = 2;
const HORDE_WANDER_MAX_DISTANCE = 6;
const HORDE_WANDER_REACHED_DISTANCE = 2;
const HORDE_HEARING_MEMBER_SAMPLES = 12;
const HORDE_SLOT_BASE_RADIUS = 0.12;
const HORDE_SLOT_RADIUS_PER_MEMBER = 0.08;
const HORDE_SLOT_MAX_RADIUS = 1.25;
const HORDE_SLOT_GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const HORDE_MEMBER_SOUND_RATIO = 0.08;
const HORDE_MEMBER_SOUND_MIN_LISTENERS = 2;
const HORDE_MEMBER_SOUND_MAX_LISTENERS = 8;
const LOUD_ACTION_SOUND_THRESHOLD = 400;

type HeardSound = {
	direction: Vec2;
	target: Vec2;
	significance: number;
	worldSignificance: number;
	loudAction: boolean;
};

type ZombieDirectorOptions = {
	soundSources?: SoundFieldSource[];
};

export function stepZombieDirector(world: World, dt: number, options: ZombieDirectorOptions = {}) {
	const zombies = Object.values(world.units).filter((unit) => unit.ownerId === ZOMBIE_OWNER_ID && unit.hp > 0);
	if (zombies.length === 0) {
		world._zombieHordes = {};
		return;
	}

	const shouldRebuild = !world._zombieHordes || world.tick % HORDE_RETARGET_TICKS === 0;
	if (shouldRebuild) world._zombieHordes = buildHordes(world, zombies);
	else refreshHordes(world);

	const hordes = Object.values(world._zombieHordes || {});
	const soundSources = options.soundSources ?? collectWorldSoundSources(world, ZOMBIE_OWNER_ID);
	const soundField = buildSoundField(soundSources);
	const targetUnits = Object.values(world.units).filter((unit) => unit.ownerId !== ZOMBIE_OWNER_ID && unit.hp > 0);

	for (const horde of hordes) {
		horde.targetMemory = Math.max(0, horde.targetMemory - dt);
		decaySoundMemory(horde, dt);
		const heardActionSound = heardActionSoundForHorde(horde, world);
		const directTarget = heardActionSound ? null : nearestPoint(targetUnits, horde.center, horde.radius + 8);
		const heardSound = heardActionSound || (directTarget ? null : heardSoundForHorde(soundField, horde, world));

		if (directTarget) {
			horde.target = centerOf(directTarget);
			horde.driftDirection = directionBetween(horde.center, horde.target) || horde.driftDirection;
			horde.targetMemory = HORDE_TARGET_MEMORY_SECONDS;
			horde.wanderTarget = null;
			horde.targetKind = "target";
		} else {
			rememberHeardSound(horde, heardSound);
			horde.target = rememberedSoundTarget(world, horde, heardSound) || driftTarget(horde);
			horde.targetMemory = 0;
			updateHordeWander(horde);
			horde.targetKind = horde.target ? (horde.soundMemory ? "sound" : "drift") : "wander";
		}

		assignZombieGoals(world, horde);
	}
	assignDirectActionSoundGoals(world, hordes);
}

function buildHordes(world: World, zombies: Unit[]): Record<string, ZombieHorde> {
	const grid = new SpatialGrid(zombies, HORDE_CELL_SIZE);
	const visited = new Set<string>();
	const previous = world._zombieHordes || {};
	const claimedPreviousHordeIds = new Set<string>();
	const hordes: Record<string, ZombieHorde> = {};

	for (const zombie of zombies) {
		if (visited.has(zombie.id)) continue;
		const members = collectConnectedZombies(grid, zombie, visited);
		const previousHordes = previousHordesFor(previous, members);
		const horde = makeHorde(nextHordeId(previousHordes, claimedPreviousHordeIds), members, previousHordes);
		hordes[horde.id] = horde;
		for (const memberId of horde.memberIds) {
			const member = world.units[memberId];
			if (!member) continue;
			member.hordeId = horde.id;
		}
	}

	return hordes;
}

function nextHordeId(previousHordes: ZombieHorde[], claimedPreviousHordeIds: Set<string>) {
	const previous = previousHordes[0] || null;
	if (previous && !claimedPreviousHordeIds.has(previous.id)) {
		claimedPreviousHordeIds.add(previous.id);
		return previous.id;
	}
	return id("h");
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
			if (distance(seed, other) > HORDE_COHORT_RADIUS) continue;
			visited.add(other.id);
			queue.push(other);
		}
	}

	return members;
}

function previousHordesFor(previous: Record<string, ZombieHorde>, members: Unit[]) {
	const counts = new Map<string, number>();
	for (const member of members) {
		if (!member.hordeId || !previous[member.hordeId]) continue;
		counts.set(member.hordeId, (counts.get(member.hordeId) || 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([hordeId]) => previous[hordeId]!)
		.filter(Boolean);
}

function makeHorde(idValue: string, members: Unit[], previousHordes: ZombieHorde[]): ZombieHorde {
	const center = averagePoint(members);
	const radius = clamp(Math.sqrt(members.length) * 1.4 + HORDE_MERGE_PADDING, HORDE_MIN_RADIUS, HORDE_MAX_RADIUS);
	const previous = previousHordes[0] || null;
	return {
		id: idValue,
		memberIds: members.map((unit) => unit.id),
		center,
		radius,
		target: previous?.target || null,
		targetMemory: previous?.targetMemory || 0,
		wanderTarget: previous?.wanderTarget || null,
		targetKind: previous?.targetKind || null,
		driftDirection: previous?.driftDirection || null,
		soundMemory: previous?.soundMemory || null,
	};
}

function assignZombieGoals(world: World, horde: ZombieHorde) {
	const target = horde.target || horde.wanderTarget;
	if (!target) {
		clearZombieGoals(world, horde);
		return;
	}
	const goalKind = horde.targetKind || (horde.target ? "target" : "wander");
	const memberIds = stableMemberIds(horde);

	for (let index = 0; index < memberIds.length; index += 1) {
		const memberId = memberIds[index]!;
		const zombie = world.units[memberId];
		if (!zombie) continue;
		zombie.hordeTarget = hordeMemberTarget(world, horde, zombie, target, index, memberIds.length);
		zombie.zombieHordeSourceTarget = target;
		zombie.zombieGoalKind = goalKind;
	}
}

function updateHordeWander(horde: ZombieHorde) {
	if (horde.target) {
		horde.wanderTarget = null;
		return;
	}
	if (horde.wanderTarget && distance(horde.center, horde.wanderTarget) > HORDE_WANDER_REACHED_DISTANCE) return;
	horde.wanderTarget = randomWanderTarget(horde.center);
}

function randomWanderTarget(center: Vec2): Vec2 {
	const angle = Math.random() * Math.PI * 2;
	const distanceOut = HORDE_WANDER_MIN_DISTANCE + Math.random() * (HORDE_WANDER_MAX_DISTANCE - HORDE_WANDER_MIN_DISTANCE);
	return {
		x: clamp(center.x + Math.cos(angle) * distanceOut, 0.5, MAP_SIZE - 0.5),
		y: clamp(center.y + Math.sin(angle) * distanceOut, 0.5, MAP_SIZE - 0.5),
	};
}

function clearZombieGoals(world: World, horde: ZombieHorde) {
	for (const memberId of horde.memberIds) {
		const zombie = world.units[memberId];
		if (!zombie) continue;
		zombie.hordeTarget = null;
		zombie.zombieHordeSourceTarget = null;
		zombie.zombieGoalKind = null;
	}
}

function assignDirectActionSoundGoals(world: World, hordes: ZombieHorde[]) {
	if (world.actionNoises.length === 0) return;
	for (const horde of hordes) {
		const heardSound = heardActionSoundForHordeMembers(world, horde);
		if (!heardSound) continue;
		const reachedExistingSound = isSameTarget(horde.soundMemory?.target || null, heardSound.target) && hasHordeMemberReached(world, horde, heardSound.target);
		if (reachedExistingSound) {
			horde.driftDirection = nonZeroDirection(heardSound.direction) || directionBetween(horde.center, heardSound.target) || horde.driftDirection;
			horde.soundMemory = null;
		} else {
			horde.driftDirection = null;
			horde.soundMemory = {
				direction: heardSound.direction,
				target: heardSound.target,
				significance: heardSound.significance,
				age: 0,
			};
		}
		const target = reachedExistingSound ? driftTarget(horde) || heardSound.target : heardSound.target;
		const goalKind = reachedExistingSound ? "drift" : "sound";
		const memberIds = stableMemberIds(horde);
		for (let index = 0; index < memberIds.length; index += 1) {
			const memberId = memberIds[index]!;
			const zombie = world.units[memberId];
			if (!zombie) continue;
			if (!zombie.zombieHordeSourceTarget || distance(zombie.zombieHordeSourceTarget, target) > 0.2) {
				zombie.zombiePath = null;
				zombie.zombiePathTarget = null;
				zombie.zombieStuckTicks = 0;
			}
			zombie.hordeTarget = hordeMemberTarget(world, horde, zombie, target, index, memberIds.length);
			zombie.zombieHordeSourceTarget = target;
			zombie.zombieGoalKind = goalKind;
		}
	}
}

function stableMemberIds(horde: ZombieHorde) {
	return [...horde.memberIds].sort();
}

function hordeMemberTarget(world: World, horde: ZombieHorde, zombie: Unit, target: Vec2, index: number, count: number): Vec2 {
	if (count <= 1) return walkableHordeTarget(world, zombie, target);
	const approach = directionBetween(horde.center, target) || horde.driftDirection || { x: 1, y: 0 };
	const side = { x: -approach.y, y: approach.x };
	const radius = Math.min(HORDE_SLOT_MAX_RADIUS, HORDE_SLOT_BASE_RADIUS + Math.sqrt(count) * HORDE_SLOT_RADIUS_PER_MEMBER);
	const angle = index * HORDE_SLOT_GOLDEN_ANGLE + (unitHash(zombie.id) % 360) * Math.PI / 180;
	const lateral = Math.cos(angle) * radius;
	const depth = Math.sin(angle) * radius * 0.75;
	return walkableHordeTarget(world, zombie, {
		x: target.x + side.x * lateral + approach.x * depth,
		y: target.y + side.y * lateral + approach.y * depth,
	});
}

function walkableHordeTarget(world: World, zombie: Unit, target: Vec2): Vec2 {
	const point = {
		x: clamp(target.x, 0.5, MAP_SIZE - 0.5),
		y: clamp(target.y, 0.5, MAP_SIZE - 0.5),
	};
	const tile = { x: Math.round(point.x), y: Math.round(point.y) };
	if (isWalkable(world, tile.x, tile.y)) return point;
	return nearestWalkablePointAround(world, point, zombie);
}

function heardActionSoundForHordeMembers(world: World, horde: ZombieHorde): HeardSound | null {
	let best: HeardSound | null = null;
	let listeners = 0;
	for (const memberId of horde.memberIds) {
		const zombie = world.units[memberId];
		if (!zombie) continue;
		const heardSound = heardActionSoundForPoint(world, zombie);
		if (!heardSound) continue;
		listeners += 1;
		if (!best || heardSound.significance > best.significance) best = heardSound;
	}
	if (best?.loudAction) return best;
	if (listeners < requiredActionSoundListeners(horde)) return null;
	return best;
}

function requiredActionSoundListeners(horde: ZombieHorde) {
	if (horde.memberIds.length <= HORDE_HEARING_MEMBER_SAMPLES) return 1;
	return Math.min(
		HORDE_MEMBER_SOUND_MAX_LISTENERS,
		Math.max(HORDE_MEMBER_SOUND_MIN_LISTENERS, Math.ceil(horde.memberIds.length * HORDE_MEMBER_SOUND_RATIO)),
	);
}

function heardActionSoundForPoint(world: World, point: Vec2): HeardSound | null {
	for (let i = world.actionNoises.length - 1; i >= 0; i -= 1) {
		const noise = world.actionNoises[i]!;
		const signal = actionNoiseSignalAt(noise, point);
		if (signal < SOUND_FIELD_MIN_SPREAD_STRENGTH) continue;
		const dx = noise.x - point.x;
		const dy = noise.y - point.y;
		const length = Math.hypot(dx, dy);
		return {
			direction: length > 0.001 ? { x: dx / length, y: dy / length } : { x: 0, y: 0 },
			target: { x: noise.x, y: noise.y },
			significance: Math.min(SOUND_FIELD_MAX_STRENGTH, signal),
			worldSignificance: Math.min(SOUND_FIELD_MAX_STRENGTH, signal),
			loudAction: isLoudActionSound(noise),
		};
	}
	return null;
}

function heardActionSoundForHorde(horde: ZombieHorde, world: World): HeardSound | null {
	const points = [horde.center, ...sampleHordeMembers(horde, world)];
	for (let i = world.actionNoises.length - 1; i >= 0; i -= 1) {
		const noise = world.actionNoises[i]!;
		const heard = heardActionNoise(noise, horde, points);
		if (heard) return heard;
	}
	return null;
}

function heardActionNoise(noise: ActionNoise, horde: ZombieHorde, points: Vec2[]): HeardSound | null {
	const bestSignal = bestActionNoiseSignal(noise, points);
	if (bestSignal < SOUND_FIELD_MIN_SPREAD_STRENGTH) return null;
	const dx = noise.x - horde.center.x;
	const dy = noise.y - horde.center.y;
	const length = Math.hypot(dx, dy);
	const direction = length > 0.001 ? { x: dx / length, y: dy / length } : horde.soundMemory?.direction || null;
	if (!direction) return null;
	const significance = Math.min(SOUND_FIELD_MAX_STRENGTH, bestSignal);
		return {
			direction,
			target: { x: noise.x, y: noise.y },
			significance,
			worldSignificance: significance,
			loudAction: isLoudActionSound(noise),
		};
}

function isLoudActionSound(noise: ActionNoise) {
	return noise.action === "devBang" || noise.sound >= LOUD_ACTION_SOUND_THRESHOLD;
}

function bestActionNoiseSignal(noise: ActionNoise, points: Vec2[]): number {
	let bestSignal = 0;
	for (const point of points) bestSignal = Math.max(bestSignal, actionNoiseSignalAt(noise, point));
	return bestSignal;
}

function actionNoiseSignalAt(noise: ActionNoise, point: Vec2): number {
	const dx = Math.abs(soundCellCoord(noise.x) - soundCellCoord(point.x));
	const dy = Math.abs(soundCellCoord(noise.y) - soundCellCoord(point.y));
	const cellDistance = Math.max(dx, dy);
	if (cellDistance === 0) return Math.min(SOUND_FIELD_MAX_STRENGTH, noise.sound);
	const overflowStrength = actionNoiseOverflowStrength(noise.sound);
	if (overflowStrength <= 0) return 0;
	return overflowStrength * SOUND_FIELD_OVERFLOW_DECAY ** (cellDistance - 1);
}

function actionNoiseOverflowStrength(sound: number): number {
	const excess = Math.max(0, sound - SOUND_FIELD_MAX_STRENGTH);
	if (excess <= 0) return 0;
	const softenedExcess = (excess * excess) / (excess + SOUND_FIELD_OVERFLOW_KNEE);
	return softenedExcess * SOUND_FIELD_OVERFLOW_DECAY;
}

function soundCellCoord(value: number) {
	return Math.max(0, Math.min(Math.ceil(MAP_SIZE / SOUND_FIELD_CELL_SIZE) - 1, Math.floor(value / SOUND_FIELD_CELL_SIZE)));
}

function heardSoundForHorde(cells: SoundFieldCell[], horde: ZombieHorde, world: World): HeardSound | null {
	const heard = [horde.center, ...sampleHordeMembers(horde, world)]
		.map((point) => heardSoundAt(cells, horde, point))
		.filter((sound): sound is HeardSound => !!sound);
	if (heard.length === 0) return null;
	return heard.reduce((best, sound) => (sound.worldSignificance > best.worldSignificance ? sound : best));
}

function sampleHordeMembers(horde: ZombieHorde, world: World): Vec2[] {
	if (horde.memberIds.length <= HORDE_HEARING_MEMBER_SAMPLES) {
		return horde.memberIds.map((memberId) => world.units[memberId]).filter((unit): unit is Unit => !!unit);
	}
	const samples: Vec2[] = [];
	const stride = horde.memberIds.length / HORDE_HEARING_MEMBER_SAMPLES;
	for (let i = 0; i < HORDE_HEARING_MEMBER_SAMPLES; i += 1) {
		const memberId = horde.memberIds[Math.floor(i * stride)];
		const member = memberId ? world.units[memberId] : null;
		if (member) samples.push(member);
	}
	return samples;
}

function heardSoundAt(cells: SoundFieldCell[], horde: ZombieHorde, point: Vec2): HeardSound | null {
	const cell = soundFieldCellAt(cells, point);
	if (!cell) return null;
	const significance = cellSignificanceForHorde(cell, horde);
	const worldSignificance = Math.max(0, cell.worldStrength);
	if (significance <= 0 && worldSignificance <= 0) return null;
	const direction = soundDirectionFromPoint(horde.center, cell, horde.soundMemory?.direction || null);
	if (!direction) return null;
		return {
			direction,
			target: { x: cell.x, y: cell.y },
			significance,
			worldSignificance,
			loudAction: false,
		};
}

function cellSignificanceForHorde(cell: SoundFieldCell, horde: ZombieHorde): number {
	return Math.max(0, cell.strength);
}

function decaySoundMemory(horde: ZombieHorde, dt: number) {
	if (!horde.soundMemory) return;
	horde.soundMemory.age += dt;
	horde.soundMemory.significance = Math.max(SOUND_MEMORY_MIN_SIGNIFICANCE, horde.soundMemory.significance - SOUND_MEMORY_DECAY_PER_SECOND * dt);
}

function rememberHeardSound(horde: ZombieHorde, heardSound: HeardSound | null) {
	if (!heardSound || heardSound.significance <= 0) return;
	const replacementSignificance = horde.soundMemory ? heardSound.worldSignificance : heardSound.significance;
	if (replacementSignificance <= 0) return;
	horde.driftDirection = null;
	horde.soundMemory = {
		direction: heardSound.direction,
		target: heardSound.target,
		significance: replacementSignificance,
		age: 0,
	};
}

function rememberedSoundTarget(world: World, horde: ZombieHorde, heardSound: HeardSound | null): Vec2 | null {
	if (!horde.soundMemory) return null;
	if (!heardSound && (distance(horde.center, horde.soundMemory.target) <= SOUND_MEMORY_REACHED_DISTANCE || hasHordeMemberReached(world, horde, horde.soundMemory.target))) {
		horde.driftDirection = horde.soundMemory.direction;
		horde.soundMemory = null;
		return null;
	}
	return horde.soundMemory.target;
}

function hasHordeMemberReached(world: World, horde: ZombieHorde, target: Vec2) {
	for (const memberId of horde.memberIds) {
		const zombie = world.units[memberId];
		if (zombie && distance(zombie, target) <= HORDE_TARGET_REACHED_DISTANCE) return true;
	}
	return false;
}

function isSameTarget(a: Vec2 | null, b: Vec2) {
	return !!a && distance(a, b) <= 0.2;
}

function driftTarget(horde: ZombieHorde): Vec2 | null {
	if (!horde.driftDirection) return null;
	return {
		x: clamp(horde.center.x + horde.driftDirection.x * SOUND_MEMORY_FOLLOW_DISTANCE, 0.5, MAP_SIZE - 0.5),
		y: clamp(horde.center.y + horde.driftDirection.y * SOUND_MEMORY_FOLLOW_DISTANCE, 0.5, MAP_SIZE - 0.5),
	};
}

function soundDirectionFromPoint(point: Vec2, cell: SoundFieldCell, fallback: Vec2 | null): Vec2 | null {
	const dx = cell.x - point.x;
	const dy = cell.y - point.y;
	const len = Math.hypot(dx, dy);
	if (len > 0.001) return { x: dx / len, y: dy / len };
	return fallback;
}

function directionBetween(from: Vec2, to: Vec2): Vec2 | null {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const len = Math.hypot(dx, dy);
	if (len <= 0.001) return null;
	return { x: dx / len, y: dy / len };
}

function nonZeroDirection(direction: Vec2): Vec2 | null {
	return Math.hypot(direction.x, direction.y) > 0.001 ? direction : null;
}

function unitHash(idValue: string): number {
	let hash = 0;
	for (let i = 0; i < idValue.length; i += 1) hash = (hash * 31 + idValue.charCodeAt(i)) | 0;
	return Math.abs(hash);
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

function averagePoint(units: Unit[]): Vec2 {
	const total = units.reduce((sum, unit) => ({ x: sum.x + unit.x, y: sum.y + unit.y }), { x: 0, y: 0 });
	return { x: total.x / units.length, y: total.y / units.length };
}

function centerOf(entity: { x: number; y: number; size?: number; width?: number; height?: number }) {
	const width = entity.width ?? entity.size ?? 1;
	const height = entity.height ?? entity.size ?? 1;
	return { x: entity.x + (width - 1) / 2, y: entity.y + (height - 1) / 2 };
}
