import { buildSoundField, collectWorldSoundSources, SOUND_FIELD_CELL_SIZE } from "./soundField.js";
import { dayNightStateAt } from "./dayNight.js";
import type { AdminLevel, AdminSnapshot, PlayerId, Snapshot, SoundDebugSource, Unit, VisibilityCache, World } from "./types.js";
import { isVisible } from "./visibility.js";

const ZOMBIE_OWNER_ID = "zombies" as PlayerId;

export function makeSnapshot(
	world: World,
	playerId: PlayerId | null = null,
	sentExplored: Set<number> | null = null,
): Snapshot {
	const player = playerId ? world.players[playerId] : null;
	const admin = buildAdminSnapshot(world, player?.adminLevel);
	const dayNight = dayNightStateFor(world);
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
		units: Object.fromEntries(Object.entries(filterVisible(world.units)).map(([id, unit]) => [id, serializeUnit(unit, player?.zombieDebug === true)])),
		buildings: Object.fromEntries(
			Object.entries(filterVisible(world.buildings)).map(([id, building]) => [id, building.serialize()]),
		),
		resources: filterVisible(world.resources),
		ruins: filterVisible(world.ruins),
		corpses: filterVisible(world.corpses),
		visibility: visible
			? {
				visible: [...visible.visible],
				// full explored sent only on the first snapshot per client; subsequent
				// snapshots send only the new tile keys discovered since last send.
				explored: exploredFull,
				exploredDelta,
			}
			: null,
		dayNight,
		leaderboard: world.leaderboard,
		notices: world.notices.slice(-8),
		soundDebug: player?.soundDebug ? buildSoundDebugSources(world) : null,
		pathDebug: player?.pathDebug === true,
		serverPerf: admin
			? {
				tps: world.serverPerf.tps,
				tickMs: world.serverPerf.tickMs,
				...(world.serverPerf.phases ? { phases: world.serverPerf.phases } : {}),
				...(world.serverPerf.zombies ? { zombies: world.serverPerf.zombies } : {}),
				...(world.serverPerf.unitAi ? { unitAi: world.serverPerf.unitAi } : {}),
				...(world.serverPerf.zombieWorker ? { zombieWorker: world.serverPerf.zombieWorker } : {}),
				...(world.serverPerf.zombieAiWorker ? { zombieAiWorker: world.serverPerf.zombieAiWorker } : {}),
			}
			: null,
		admin,
	};
}

function dayNightStateFor(world: World) {
	return dayNightStateAt((Date.now() - (world.startedAt ?? 0)) / 1000 + (world.timeOffsetSeconds || 0));
}

function buildAdminSnapshot(world: World, level: AdminLevel | undefined): AdminSnapshot | null {
	if (!level) return null;
	const canViewIpAddresses = level === "moderator" || level === "operator";
	return {
		level,
		serverPerf: {
			tps: world.serverPerf.tps,
			tickMs: world.serverPerf.tickMs,
			...(world.serverPerf.phases ? { phases: world.serverPerf.phases } : {}),
			...(world.serverPerf.zombies ? { zombies: world.serverPerf.zombies } : {}),
			...(world.serverPerf.unitAi ? { unitAi: world.serverPerf.unitAi } : {}),
			...(world.serverPerf.zombieWorker ? { zombieWorker: world.serverPerf.zombieWorker } : {}),
			...(world.serverPerf.zombieAiWorker ? { zombieAiWorker: world.serverPerf.zombieAiWorker } : {}),
			samples: world.serverPerf.samples.slice(),
		},
		players: Object.values(world.players).map((player) => ({
			id: player.id,
			name: player.name,
			color: player.color,
			defeated: player.defeated,
			score: player.score,
			population: player.population,
			popCap: player.popCap,
			joinedAt: player.joinedAt,
			connected: (player.connection?.streamCount ?? 0) > 0,
			lastSeenAt: player.connection?.lastSeenAt ?? null,
			pingMs: player.connection?.pingMs ?? null,
			...(canViewIpAddresses ? { ipAddress: player.connection?.ipAddress ?? "unknown" } : {}),
		})),
		events: world.notices.slice(-8),
		logs: world.adminLogs.slice(-200),
	};
}

function serializeUnit(unit: Unit, includeZombieDebug: boolean): Unit {
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
		...(unit.sprite ? { sprite: unit.sprite } : {}),
		...(unit.vision !== undefined ? { vision: unit.vision } : {}),
		...(includeZombieDebug && unit.type === "zombie" ? { zombieDebugState: zombieDebugState(unit), zombieHordeColor: zombieHordeColor(unit) } : {}),
	};
}

function zombieDebugState(unit: Unit) {
	if (unit.zombieStuckTicks && unit.zombieStuckTicks >= 3) return "stuck";
	if (unit.zombiePath?.length) return "pathing";
	if (unit.zombieGoalKind === "target") return "aggro";
	if (unit.zombieGoalKind === "drift") return "sound";
	if (unit.zombieGoalKind === "sound" || unit.hordeTarget) return "sound";
	if (unit.zombieGoalKind === "wander") return "wander";
	if (unit.zombieStuckTicks && unit.zombieStuckTicks > 0) return "blocked";
	return "idle";
}

function zombieHordeColor(unit: Unit) {
	if (!unit.hordeId) return "#d8d0c0";
	const colors = [
		"#f94144",
		"#f3722c",
		"#f9c74f",
		"#90be6d",
		"#43aa8b",
		"#4d96ff",
		"#7b61ff",
		"#ff5da2",
		"#00c2ff",
		"#b8f23a",
		"#ff9f1c",
		"#c77dff",
	];
	let hash = 0;
	for (let i = 0; i < unit.hordeId.length; i += 1) hash = (hash * 31 + unit.hordeId.charCodeAt(i)) >>> 0;
	return colors[hash % colors.length]!;
}

function buildSoundDebugSources(world: World): SoundDebugSource[] {
	return buildSoundField(collectWorldSoundSources(world, ZOMBIE_OWNER_ID, { includeZombies: true })).map((cell) => ({
		id: cell.id,
		kind: "field",
		soundKind: cell.zombieStrength > cell.worldStrength ? "zombie" : "world",
		label: `${cell.sourceCount} source${cell.sourceCount === 1 ? "" : "s"}`,
		x: cell.x,
		y: cell.y,
		strength: cell.strength,
		range: SOUND_FIELD_CELL_SIZE,
		cellX: cell.cellX,
		cellY: cell.cellY,
		cellSize: SOUND_FIELD_CELL_SIZE,
		rawStrength: cell.rawStrength,
		sourceCount: cell.sourceCount,
		overflow: cell.overflow,
		worldStrength: cell.worldStrength,
		zombieStrength: cell.zombieStrength,
	}));
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
	const visionMultiplier = dayNightStateFor(world).visionMultiplier;
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
		const radius = visionRadius(unit.vision || 5, visionMultiplier);
		addCircle(Math.round(unit.x), Math.round(unit.y), radius);
	}
	for (const building of Object.values(world.buildings)) {
		if (building.ownerId !== playerId) continue;
		const radius = visionRadius(building.vision || 5, visionMultiplier);
		const cx = Math.round(building.x + ((building.width || building.size || 1) - 1) / 2);
		const cy = Math.round(building.y + ((building.height || building.size || 1) - 1) / 2);
		addCircle(cx, cy, radius);
	}
	player.explored = explored;
	return { visible, explored };
}

function visionRadius(baseVision: number, multiplier: number) {
	return Math.max(1, Math.round(baseVision * multiplier));
}
