import { mkdirSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { makeSnapshot } from "../shared/messages.js";
import { firstPlaceDurationMs } from "./world.js";
import type { GlobalLeaderboardEntry, Player, Snapshot, World } from "../shared/types.js";

const LEADERBOARD_LIMIT = 10;
const STORE_DIR = process.env.LEADERBOARD_DATA_DIR || join(process.cwd(), "data");
const STORE_FILE = join(STORE_DIR, "leaderboard.json");

interface StoredLeaderboard {
	entries: GlobalLeaderboardEntry[];
	snapshots: Record<string, Snapshot>;
	pendingEntries: GlobalLeaderboardEntry[];
	pendingSnapshots: Record<string, Snapshot>;
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
		await this.save();
	}

	async trackWorldPeaks(world: World) {
		await this.load();
		this.trackDeadKingdoms(world);
		let changed = false;
		for (const player of Object.values(world.players)) {
			if (this.shouldTrack(world, player)) {
				this.trackPeak(world, player);
				changed = true;
			}
		}
		if (!changed) return;
		this.trimPending();
		await this.save();
	}

	async publishWorldPeaks(world: World | null) {
		await this.load();
		if (!this.data.pendingEntries.length) return;
		const entries = this.finalizePendingEntries(world);
		// const playerNames = new Set(entries.map((entry) => entry.playerName));
		// this.data.entries = this.data.entries.filter((entry) => !playerNames.has(entry.playerName));
		this.data.entries.push(...entries);
		Object.assign(this.data.snapshots, this.data.pendingSnapshots);
		this.data.pendingEntries = [];
		this.data.pendingSnapshots = {};
		this.trimStored();
		await this.save();
	}

	private shouldTrack(world: World, player: Player) {
		if (player.defeated || player.score <= 0) return false;
		// const existingBest = this.allCandidateEntries(world).find((entry) => entry.playerName === player.name);
		// if (existingBest && existingBest.score >= player.score) return false;
		const candidates = this.allCandidateEntries(world);
		if (candidates.length < LEADERBOARD_LIMIT) return true;
		candidates.sort(compareEntries);
		return player.score > candidates[candidates.length - 1]!.score;
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
		if (changed) void this.save();
	}

	private trackPeak(world: World, player: Player) {
		const snapshotId = `${Date.now()}-${player.id}`;
		const oldEntries = this.data.pendingEntries.filter((entry) => entry.playerName === player.name);
		this.data.pendingEntries = this.data.pendingEntries.filter((entry) => entry.playerName !== player.name);
		for (const entry of oldEntries) delete this.data.pendingSnapshots[entry.snapshotId];
		this.data.pendingEntries.push({
			id: snapshotId,
			playerName: player.name,
			playerColor: player.color,
			score: player.score,
			achievedAt: Date.now(),
			snapshotId,
			firstPlaceDurationMs: firstPlaceDurationMs(world, player.id),
		});
		this.data.pendingSnapshots[snapshotId] = {
			...makeSnapshot(world),
			playerId: player.id,
			visibility: null,
			serverPerf: null,
			admin: null,
			soundDebug: null,
			pathDebug: false,
		};
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

	private allCandidateEntries(_world?: World) {
		return [
			...this.data.entries,
			...this.data.pendingEntries,
		];
	}

	private async load() {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const parsed = JSON.parse(await fs.readFile(STORE_FILE, "utf8")) as Partial<StoredLeaderboard>;
			this.data = {
				entries: Array.isArray(parsed.entries) ? parsed.entries.map((entry) => ({
					...entry,
					firstPlaceDurationMs: entry.firstPlaceDurationMs ?? 0,
				})) : [],
				snapshots: parsed.snapshots && typeof parsed.snapshots === "object" ? parsed.snapshots : {},
				pendingEntries: Array.isArray(parsed.pendingEntries) ? parsed.pendingEntries.map((entry) => ({
					...entry,
					firstPlaceDurationMs: entry.firstPlaceDurationMs ?? 0,
				})) : [],
				pendingSnapshots: parsed.pendingSnapshots && typeof parsed.pendingSnapshots === "object" ? parsed.pendingSnapshots : {},
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

	private async save() {
		const payload = JSON.stringify(this.data, null, 2);
		try {
			mkdirSync(dirname(STORE_FILE), { recursive: true });
			writeFileSync(STORE_FILE, payload);
		} catch (error) {
			console.warn(`Could not write global leaderboard: ${(error as Error).message}`);
		}
	}

	private finalizePendingEntries(world: World | null) {
		return this.data.pendingEntries.map((entry) => {
			const playerId = this.data.pendingSnapshots[entry.snapshotId]?.playerId;
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
