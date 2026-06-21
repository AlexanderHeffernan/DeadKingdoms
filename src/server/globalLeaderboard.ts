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
}

export class GlobalLeaderboardStore {
	private data: StoredLeaderboard = { entries: [], snapshots: {} };
	private loaded = false;

	async entries() {
		await this.load();
		return this.data.entries.slice();
	}

	async snapshot(id: string) {
		await this.load();
		return this.data.snapshots[id] ?? null;
	}

	async trackWorldPeaks(world: World) {
		await this.load();
		let changed = false;
		for (const player of Object.values(world.players)) {
			if (this.shouldTrack(world, player)) {
				this.trackPeak(world, player);
				changed = true;
			}
		}
		if (!changed) return;
		this.trimPending(world);
	}

	async publishWorldPeaks(world: World | null) {
		if (!world?._pendingGlobalLeaderboard?.entries.length) return;
		await this.load();
		this.data.entries.push(...this.finalizePendingEntries(world));
		Object.assign(this.data.snapshots, world._pendingGlobalLeaderboard.snapshots);
		this.trimStored();
		await this.save();
		world._pendingGlobalLeaderboard = { entries: [], snapshots: {} };
	}

	private shouldTrack(world: World, player: Player) {
		if (player.defeated || player.score <= 0) return false;
		const existingBest = this.allCandidateEntries(world).find((entry) => entry.playerName === player.name);
		if (existingBest && existingBest.score >= player.score) return false;
		const candidates = this.allCandidateEntries(world);
		if (candidates.length < LEADERBOARD_LIMIT) return true;
		candidates.sort(compareEntries);
		return player.score > candidates[candidates.length - 1]!.score;
	}

	private trackPeak(world: World, player: Player) {
		const snapshotId = `${Date.now()}-${player.id}`;
		world._pendingGlobalLeaderboard ??= { entries: [], snapshots: {} };
		world._pendingGlobalLeaderboard.entries = world._pendingGlobalLeaderboard.entries.filter((entry) => entry.playerName !== player.name);
		world._pendingGlobalLeaderboard.entries.push({
			id: snapshotId,
			playerName: player.name,
			playerColor: player.color,
			score: player.score,
			achievedAt: Date.now(),
			snapshotId,
			firstPlaceDurationMs: firstPlaceDurationMs(world, player.id),
		});
		world._pendingGlobalLeaderboard.snapshots[snapshotId] = {
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

	private trimPending(world: World) {
		const pending = world._pendingGlobalLeaderboard;
		if (!pending) return;
		const globalIds = new Set(this.data.entries.map((entry) => entry.snapshotId));
		const livePending = this.allCandidateEntries(world)
			.sort(compareEntries)
			.slice(0, LEADERBOARD_LIMIT)
			.filter((entry) => !globalIds.has(entry.snapshotId));
		pending.entries = livePending;
		const liveIds = new Set(livePending.map((entry) => entry.snapshotId));
		for (const id of Object.keys(pending.snapshots)) {
			if (!liveIds.has(id)) delete pending.snapshots[id];
		}
	}

	private allCandidateEntries(world: World) {
		return [
			...this.data.entries,
			...(world._pendingGlobalLeaderboard?.entries ?? []),
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
			};
			this.trimStored();
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

	private finalizePendingEntries(world: World) {
		const pending = world._pendingGlobalLeaderboard;
		if (!pending) return [];
		return pending.entries.map((entry) => {
			const playerId = pending.snapshots[entry.snapshotId]?.playerId;
			return {
				...entry,
				firstPlaceDurationMs: playerId ? firstPlaceDurationMs(world, playerId) : entry.firstPlaceDurationMs,
			};
		});
	}
}

function compareEntries(a: GlobalLeaderboardEntry, b: GlobalLeaderboardEntry) {
	return b.score - a.score || a.achievedAt - b.achievedAt;
}
