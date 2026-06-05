import { SOUND_HEARING_BASE_RANGE, SOUND_HEARING_RANGE_PER_SOUND } from "./config.js";
import { unitBehaviorFor } from "./unitRegistry.js";
import type { PlayerId, Snapshot, SoundDebugSource, Unit, VisibilityCache, World } from "./types.js";
import { isVisible } from "./visibility.js";

const ZOMBIE_OWNER_ID = "zombies" as PlayerId;
const ZOMBIE_GROUP_SOUND_RADIUS = 5;

export function makeSnapshot(
	world: World,
	playerId: PlayerId | null = null,
	sentExplored: Set<number> | null = null,
): Snapshot {
	const player = playerId ? world.players[playerId] : null;
	const visible = playerId && !player?.godMode ? cachedVisibility(world, playerId) : null;
	const visibleSet = visible ? visible.visible : null;
	const filterVisible = <T extends { x: number; y: number; size?: number }>(entities: Record<string, T>, set = visibleSet): Record<string, T> => {
		if (!set) return entities;
		const out: Record<string, T> = {};
		for (const id in entities) {
			const entity = entities[id]!;
			if (isVisible(set, entity.x, entity.y, entity.size || 1, world.map.size)) out[id] = entity;
		}
		return out;
	};

	let exploredDelta = null;
	let exploredFull = null;
	if (visible) {
		if (sentExplored) {
			exploredDelta = [];
			for (const key of visible.explored) {
				if (!sentExplored.has(key)) {
					sentExplored.add(key);
					exploredDelta.push(key);
				}
			}
		} else {
			exploredFull = [...visible.explored];
		}
	}

	return {
		type: "snapshot",
		now: Date.now(),
		playerId,
		map: world.map,
		players: Object.fromEntries(
			Object.entries(world.players).map(([id, player]) => [
				id,
				{
					id,
					name: player.name,
					color: player.color,
					resources: player.resources,
					autoReplenishFarms: player.autoReplenishFarms,
					population: player.population,
					popCap: player.popCap,
					defeated: player.defeated,
					score: player.score,
					joinedAt: player.joinedAt,
				},
			]),
		),
		units: Object.fromEntries(Object.entries(filterVisible(world.units)).map(([id, unit]) => [id, serializeUnit(unit)])),
		buildings: Object.fromEntries(
			Object.entries(filterVisible(world.buildings)).map(([id, building]) => [id, building.serialize()]),
		),
		resources: filterVisible(world.resources),
		ruins: filterVisible(world.ruins),
		visibility: visible
			? {
				visible: [...visible.visible],
				// full explored sent only on the first snapshot per client; subsequent
				// snapshots send only the new tile keys discovered since last send.
				explored: exploredFull,
				exploredDelta,
			}
			: null,
		leaderboard: world.leaderboard,
		notices: world.notices.slice(-8),
		soundDebug: player?.soundDebug ? buildSoundDebugSources(world) : null,
		serverPerf: {
			tps: world.serverPerf.tps,
			tickMs: world.serverPerf.tickMs,
		},
	};
}

function serializeUnit(unit: Unit): Unit {
	return {
		id: unit.id,
		kind: unit.kind,
		ownerId: unit.ownerId,
		type: unit.type,
		x: unit.x,
		y: unit.y,
		hp: unit.hp,
		maxHp: unit.maxHp,
		command: unit.command,
		cooldown: unit.cooldown,
		attackFlash: unit.attackFlash,
		workFlash: unit.workFlash,
		facing: unit.facing,
		carried: unit.carried,
		selected: unit.selected,
		...(unit.vision !== undefined ? { vision: unit.vision } : {}),
	};
}

function buildSoundDebugSources(world: World): SoundDebugSource[] {
	const sources: SoundDebugSource[] = [];
	const add = (
		id: string,
		kind: SoundDebugSource["kind"],
		soundKind: SoundDebugSource["soundKind"],
		label: string,
		point: { x: number; y: number },
		strength: number,
	) => {
		if (strength <= 0) return;
		sources.push({
			id,
			kind,
			soundKind,
			label,
			x: point.x,
			y: point.y,
			strength,
			range: SOUND_HEARING_BASE_RANGE + strength * SOUND_HEARING_RANGE_PER_SOUND,
		});
	};
	for (const unit of Object.values(world.units)) {
		const behavior = unitBehaviorFor(unit.type);
		const soundKind = unit.ownerId === ZOMBIE_OWNER_ID ? "zombie" : "civilization";
		const strength = soundKind === "zombie" ? zombieGroupSound(world, unit) : behavior.soundLevel();
		add(unit.id, "unit", soundKind, unit.type, unit, strength);
	}
	for (const building of Object.values(world.buildings)) {
		add(building.id, "building", "civilization", building.type, centerOf(building), building.soundLevel());
	}
	for (const noise of world.actionNoises) {
		add(noise.id, "action", "civilization", noise.action, noise, noise.sound);
	}
	return sources;
}

function zombieGroupSound(world: World, source: Unit) {
	const base = unitBehaviorFor(source.type).soundLevel();
	if (base <= 0) return 0;
	let nearbyZombies = 0;
	for (const unit of Object.values(world.units)) {
		if (unit.ownerId !== ZOMBIE_OWNER_ID) continue;
		if (dist(source, unit) <= ZOMBIE_GROUP_SOUND_RADIUS) nearbyZombies += 1;
	}
	return Math.max(base, nearbyZombies * base);
}

function centerOf(entity: { x: number; y: number; size?: number }) {
	const size = entity.size || 1;
	return { x: entity.x + (size - 1) / 2, y: entity.y + (size - 1) / 2 };
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function cachedVisibility(world: World, playerId: PlayerId): VisibilityCache | null {
	const player = world.players[playerId];
	if (!player) return null;
	if (player._visCache && player._visCache.tick === world.tick) return player._visCache;
	const computed = visibleTiles(world, playerId);
	computed.tick = world.tick;
	player._visCache = computed;
	return computed;
}

function visibleTiles(world: World, playerId: PlayerId): VisibilityCache {
	const player = world.players[playerId];
	const explored: Set<number> = player?.explored || new Set();
	const visible = new Set<number>();
	if (!player) return { visible, explored };
	const size = world.map.size;
	const addCircle = (cx: number, cy: number, radius: number) => {
		const r2 = radius * radius;
		const minX = Math.max(0, cx - radius);
		const maxX = Math.min(size - 1, cx + radius);
		const minY = Math.max(0, cy - radius);
		const maxY = Math.min(size - 1, cy + radius);
		for (let y = minY; y <= maxY; y += 1) {
			const dy = y - cy;
			for (let x = minX; x <= maxX; x += 1) {
				const dx = x - cx;
				if (dx * dx + dy * dy > r2) continue;
				const key = y * size + x;
				visible.add(key);
				explored.add(key);
			}
		}
	};
	for (const unit of Object.values(world.units)) {
		if (unit.ownerId !== playerId) continue;
		const radius = unit.vision || 5;
		addCircle(Math.round(unit.x), Math.round(unit.y), radius);
	}
	for (const building of Object.values(world.buildings)) {
		if (building.ownerId !== playerId) continue;
		const radius = building.vision || 5;
		const cx = Math.round(building.x + ((building.size || 1) - 1) / 2);
		const cy = Math.round(building.y + ((building.size || 1) - 1) / 2);
		addCircle(cx, cy, radius);
	}
	player.explored = explored;
	return { visible, explored };
}
