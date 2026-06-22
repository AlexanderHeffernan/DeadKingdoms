import { promises as fs } from "node:fs";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import { firstPlaceDurationMs, recordServerPerfPhase } from "./world.js";
import type { GlobalLeaderboardEntry, LeaderboardPreviewSnapshot, Player, PlayerId, World } from "../shared/types.js";

const LEADERBOARD_LIMIT = 10;
const STORE_DIR = process.env.LEADERBOARD_DATA_DIR || join(process.cwd(), "data");
const STORE_FILE = join(STORE_DIR, "leaderboard.json");

interface TrackWorldPeaksOptions {
	force?: boolean;
	playerId?: PlayerId;
}

type PerfSink = (name: string, label: string, ms: number) => void;

interface StoredLeaderboard {
	entries: GlobalLeaderboardEntry[];
	snapshots: Record<string, LeaderboardPreviewSnapshot>;
	pendingEntries: GlobalLeaderboardEntry[];
	pendingSnapshots: Record<string, LeaderboardPreviewSnapshot>;
	deadKingdoms: number;
}

export class GlobalLeaderboardStore {
	private data: StoredLeaderboard = {
		entries: [],
		snapshots: {},
		pendingEntries: [],
		pendingSnapshots: {},
		deadKingdoms: 0,
	};
	private loaded = false;
	private saveQueued = false;
	private saveInProgress = false;
	private perfSink: PerfSink | null = null;

	setPerfSink(perfSink: PerfSink | null) {
		this.perfSink = perfSink;
	}

	async entries() {
		await this.load();
		return this.data.entries.slice();
	}

	async snapshot(id: string) {
		await this.load();
		return this.data.snapshots[id] ?? null;
	}

	async deadKingdoms() {
		await this.load();
		return this.data.deadKingdoms;
	}

	async countDeadKingdom() {
		await this.load();
		this.data.deadKingdoms += 1;
		this.queueSave();
	}

	async trackWorldPeaks(world: World, options: TrackWorldPeaksOptions = {}) {
		const startedAt = performance.now();
		try {
			await this.load();
			this.trackDeadKingdoms(world);
			const players = this.qualifyingPlayers(world, options);
			for (const player of Object.values(world.players)) {
				if (this.shouldEvaluate(world, player, options)) this.rememberScore(world, player);
			}
			if (!players.length) return;
			const snapshotId = `${Date.now()}-world-${world.tick}`;
			this.data.pendingSnapshots[snapshotId] = this.snapshotForWorld(world);
			for (const player of players) {
				this.trackPeak(world, player, snapshotId);
			}
			this.trimPending();
			this.queueSave();
		} finally {
			recordServerPerfPhase(world, "globalLeaderboardTrack", "Global leaderboard track", performance.now() - startedAt);
		}
	}

	async publishWorldPeaks(world: World | null) {
		const startedAt = performance.now();
		try {
			await this.load();
			if (world) await this.trackWorldPeaks(world, { force: true });
			if (!this.data.pendingEntries.length) return;
			const entries = this.finalizePendingEntries(world);
			// const playerNames = new Set(entries.map((entry) => entry.playerName));
			// this.data.entries = this.data.entries.filter((entry) => !playerNames.has(entry.playerName));
			this.data.entries.push(...entries);
			Object.assign(this.data.snapshots, this.data.pendingSnapshots);
			this.data.pendingEntries = [];
			this.data.pendingSnapshots = {};
			this.trimStored();
			this.queueSave();
		} finally {
			if (world) recordServerPerfPhase(world, "globalLeaderboardPublish", "Global leaderboard publish", performance.now() - startedAt);
		}
	}

	private shouldTrack(world: World, player: Player) {
		if (player.defeated || player.score <= 0) return false;
		const existingBest = this.pendingEntryForPlayer(player.id);
		if (existingBest && existingBest.score >= player.score) return false;
		const candidates = this.allCandidateEntries();
		if (candidates.length < LEADERBOARD_LIMIT) return true;
		candidates.sort(compareEntries);
		return player.score > candidates[candidates.length - 1]!.score;
	}

	private qualifyingPlayers(world: World, options: TrackWorldPeaksOptions) {
		return Object.values(world.players).filter((player) => (
			this.shouldEvaluate(world, player, options) &&
			this.shouldTrack(world, player)
		));
	}

	private shouldEvaluate(world: World, player: Player, options: TrackWorldPeaksOptions) {
		if (options.playerId && player.id !== options.playerId) return false;
		if (options.force) return true;
		return world._globalLeaderboardDirtyPlayerIds?.[player.id] === true;
	}

	private rememberScore(world: World, player: Player) {
		if (world._globalLeaderboardDirtyPlayerIds) delete world._globalLeaderboardDirtyPlayerIds[player.id];
	}

	private trackDeadKingdoms(world: World) {
		let changed = false;
		world._countedDeadKingdomPlayerIds ??= {};
		for (const player of Object.values(world.players)) {
			if (!player.defeated || world._countedDeadKingdomPlayerIds[player.id]) continue;
			world._countedDeadKingdomPlayerIds[player.id] = true;
			this.data.deadKingdoms += 1;
			changed = true;
		}
		if (changed) this.queueSave();
	}

	private trackPeak(world: World, player: Player, snapshotId: string) {
		const oldEntries = this.data.pendingEntries.filter((entry) => this.pendingEntryPlayerId(entry) === player.id);
		this.data.pendingEntries = this.data.pendingEntries.filter((entry) => this.pendingEntryPlayerId(entry) !== player.id);
		for (const entry of oldEntries) this.deleteSnapshotIfUnused(entry.snapshotId);
		this.data.pendingEntries.push({
			id: `${snapshotId}-${player.id}`,
			playerId: player.id,
			playerName: player.name,
			playerColor: player.color,
			score: player.score,
			achievedAt: Date.now(),
			snapshotId,
			firstPlaceDurationMs: firstPlaceDurationMs(world, player.id),
		});
	}

	private snapshotForWorld(world: World) {
		return {
			type: "leaderboardPreview",
			now: Date.now(),
			playerId: null,
			map: world.map,
			players: Object.fromEntries(
				Object.entries(world.players).map(([id, player]) => [
					id,
					{
						id,
						name: player.name,
						color: player.color,
						defeated: player.defeated,
						score: player.score,
					},
				]),
			),
			units: Object.fromEntries(Object.entries(world.units).map(([id, unit]) => [
				id,
				{
					id,
					kind: unit.kind,
					type: unit.type,
					ownerId: unit.ownerId,
					x: unit.x,
					y: unit.y,
					...(unit.size !== undefined ? { size: unit.size } : {}),
					...(unit.width !== undefined ? { width: unit.width } : {}),
					...(unit.height !== undefined ? { height: unit.height } : {}),
					facing: unit.facing,
					...(unit.sprite ? { sprite: unit.sprite } : {}),
				},
			])),
			buildings: Object.fromEntries(Object.entries(world.buildings).map(([id, building]) => {
				const snapshot = building.serialize();
				return [
					id,
					{
						id,
						kind: snapshot.kind,
						type: snapshot.type,
						ownerId: snapshot.ownerId,
						x: snapshot.x,
						y: snapshot.y,
						size: snapshot.size,
						width: snapshot.width,
						height: snapshot.height,
					},
				];
			})),
			resources: Object.fromEntries(Object.entries(world.resources).map(([id, resource]) => [
				id,
				{
					id,
					kind: resource.kind,
					type: resource.type,
					x: resource.x,
					y: resource.y,
					...(resource.size !== undefined ? { size: resource.size } : {}),
					...(resource.width !== undefined ? { width: resource.width } : {}),
					...(resource.height !== undefined ? { height: resource.height } : {}),
					resource: resource.resource,
					...(resource.stage ? { stage: resource.stage } : {}),
					...(resource.sprite ? { sprite: resource.sprite } : {}),
				},
			])),
			ruins: Object.fromEntries(Object.entries(world.ruins).map(([id, ruin]) => [
				id,
				{
					id,
					kind: ruin.kind,
					type: ruin.type,
					x: ruin.x,
					y: ruin.y,
					size: ruin.size,
					...(ruin.width !== undefined ? { width: ruin.width } : {}),
					...(ruin.height !== undefined ? { height: ruin.height } : {}),
				},
			])),
			corpses: Object.fromEntries(Object.entries(world.corpses).map(([id, corpse]) => [
				id,
				{
					id,
					kind: corpse.kind,
					type: corpse.type,
					originUnitType: corpse.originUnitType,
					ownerId: corpse.ownerId,
					x: corpse.x,
					y: corpse.y,
					size: corpse.size,
					zombieSprite: corpse.zombieSprite,
				},
			])),
		} satisfies LeaderboardPreviewSnapshot;
	}

	private deleteSnapshotIfUnused(snapshotId: string) {
		if (this.data.pendingEntries.some((entry) => entry.snapshotId === snapshotId)) return;
		delete this.data.pendingSnapshots[snapshotId];
	}

	private trimStored() {
		this.data.entries.sort(compareEntries);
		this.data.entries = this.data.entries.slice(0, LEADERBOARD_LIMIT);
		const liveIds = new Set(this.data.entries.map((entry) => entry.snapshotId));
		for (const id of Object.keys(this.data.snapshots)) {
			if (!liveIds.has(id)) delete this.data.snapshots[id];
		}
	}

	private trimPending() {
		const globalIds = new Set(this.data.entries.map((entry) => entry.snapshotId));
		const livePending = this.allCandidateEntries()
			.sort(compareEntries)
			.slice(0, LEADERBOARD_LIMIT)
			.filter((entry) => !globalIds.has(entry.snapshotId));
		this.data.pendingEntries = livePending;
		const liveIds = new Set(livePending.map((entry) => entry.snapshotId));
		for (const id of Object.keys(this.data.pendingSnapshots)) {
			if (!liveIds.has(id)) delete this.data.pendingSnapshots[id];
		}
	}

	private allCandidateEntries() {
		return [
			...this.data.entries,
			...this.data.pendingEntries,
		];
	}

	private pendingEntryForPlayer(playerId: string) {
		return this.data.pendingEntries.find((entry) => this.pendingEntryPlayerId(entry) === playerId);
	}

	private pendingEntryPlayerId(entry: GlobalLeaderboardEntry) {
		return entry.playerId ?? this.data.pendingSnapshots[entry.snapshotId]?.playerId;
	}

	private async load() {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const parsed = JSON.parse(await fs.readFile(STORE_FILE, "utf8")) as Partial<StoredLeaderboard>;
			const snapshots = parsed.snapshots && typeof parsed.snapshots === "object" ? parsed.snapshots : {};
			const pendingSnapshots = parsed.pendingSnapshots && typeof parsed.pendingSnapshots === "object" ? parsed.pendingSnapshots : {};
			this.data = {
				entries: Array.isArray(parsed.entries) ? parsed.entries.map((entry) => ({
					...entry,
					playerId: entry.playerId ?? snapshots[entry.snapshotId]?.playerId ?? "",
					firstPlaceDurationMs: entry.firstPlaceDurationMs ?? 0,
				})) : [],
				snapshots,
				pendingEntries: Array.isArray(parsed.pendingEntries) ? parsed.pendingEntries.map((entry) => ({
					...entry,
					playerId: entry.playerId ?? pendingSnapshots[entry.snapshotId]?.playerId ?? "",
					firstPlaceDurationMs: entry.firstPlaceDurationMs ?? 0,
				})) : [],
				pendingSnapshots,
				deadKingdoms: Number.isFinite(parsed.deadKingdoms) ? Number(parsed.deadKingdoms) : 0,
			};
			this.trimStored();
			this.trimPending();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.warn(`Could not read global leaderboard: ${(error as Error).message}`);
			}
		}
	}

	private queueSave() {
		this.saveQueued = true;
		if (!this.saveInProgress) void this.flushSave();
	}

	private async flushSave() {
		this.saveInProgress = true;
		while (this.saveQueued) {
			this.saveQueued = false;
			const payload = JSON.stringify(this.data, null, 2);
			const startedAt = performance.now();
			try {
				await fs.mkdir(dirname(STORE_FILE), { recursive: true });
				await fs.writeFile(STORE_FILE, payload);
			} catch (error) {
				console.warn(`Could not write global leaderboard: ${(error as Error).message}`);
			} finally {
				this.recordPerf("globalLeaderboardSave", "Global leaderboard save", performance.now() - startedAt);
			}
		}
		this.saveInProgress = false;
	}

	private recordPerf(name: string, label: string, ms: number) {
		this.perfSink?.(name, label, ms);
	}

	private finalizePendingEntries(world: World | null) {
		return this.data.pendingEntries.map((entry) => {
			const playerId = this.pendingEntryPlayerId(entry);
			return {
				...entry,
				firstPlaceDurationMs: world && playerId ? firstPlaceDurationMs(world, playerId) : entry.firstPlaceDurationMs,
			};
		});
	}
}

function compareEntries(a: GlobalLeaderboardEntry, b: GlobalLeaderboardEntry) {
	return b.score - a.score || a.achievedAt - b.achievedAt;
}
