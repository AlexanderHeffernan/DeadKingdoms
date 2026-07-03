import { DAY_NIGHT_CYCLE_SECONDS, dayNightStateAt } from "../../src/shared/dayNight.js";
import { deserializeBuilding } from "../../src/shared/buildings/index.js";
import type { LeaderboardPreviewSnapshot, Snapshot, SnapshotDelta, SnapshotMessage } from "../../src/shared/types.js";
import type { ClientSnapshot, GameState } from "./clientTypes.js";

export class SnapshotStore {
	private lastSeq = 0;

	constructor(private readonly state: GameState) {}

	fromMessage(message: SnapshotMessage): ClientSnapshot | null {
		if (message.type === "snapshot") {
			this.lastSeq = message.seq ?? 0;
			return this.hydrate(message);
		}
		if (!this.state.snapshot || message.baseSeq !== this.lastSeq) return null;
		const merged = this.mergeDelta(this.state.snapshot, message);
		this.lastSeq = message.seq;
		return this.hydrate(merged);
	}

	applyVisibility(snapshot: ClientSnapshot) {
		if (!snapshot.visibility) return;
		if (Array.isArray(snapshot.visibility.explored)) {
			this.state.exploredSet = new Set(snapshot.visibility.explored);
		} else if (Array.isArray(snapshot.visibility.exploredDelta)) {
			for (const key of snapshot.visibility.exploredDelta) this.state.exploredSet.add(key);
		}
		snapshot.visibility.visibleSet = new Set(snapshot.visibility.visible);
		snapshot.visibility.exploredSet = this.state.exploredSet;
	}

	hydrate(snapshot: Snapshot): ClientSnapshot {
		const buildings = Object.fromEntries(
			Object.entries(snapshot.buildings).map(([id, building]) => [id, deserializeBuilding(building)]),
		) as ClientSnapshot["buildings"];
		return {
			...snapshot,
			buildings,
			corpses: snapshot.corpses || {},
			dayNight: this.offsetDayNight(snapshot.dayNight),
		};
	}

	hydratePreview(snapshot: LeaderboardPreviewSnapshot): ClientSnapshot {
		return this.hydrate({
			type: "snapshot",
			now: snapshot.now,
			playerId: snapshot.playerId,
			map: snapshot.map,
			players: Object.fromEntries(Object.entries(snapshot.players).map(([id, player]) => [
				id,
				{
					...player,
					resources: { wood: 0, food: 0, ore: 0 },
					autoReplenishFarms: false,
					population: 0,
					popCap: 0,
					workerCounts: { idle: 0, gathering: { wood: 0, food: 0, ore: 0 } },
					joinedAt: 0,
				},
			])),
			units: Object.fromEntries(Object.entries(snapshot.units).map(([id, unit]) => [
				id,
				{
					...unit,
					hp: 1,
					maxHp: 1,
					command: { type: "idle" },
					cooldown: 0,
					attackFlash: 0,
					workFlash: 0,
					carried: null,
					selected: false,
				},
			])),
			buildings: Object.fromEntries(Object.entries(snapshot.buildings).map(([id, building]) => [
				id,
				{
					...building,
					hp: 1,
					maxHp: 1,
					completed: true,
					repairPaidUntilHp: undefined,
					builderIds: [],
					queue: [],
				},
			])),
			resources: Object.fromEntries(Object.entries(snapshot.resources).map(([id, resource]) => [
				id,
				{
					...resource,
					amount: 1,
					maxAmount: 1,
				},
			])),
			ruins: Object.fromEntries(Object.entries(snapshot.ruins).map(([id, ruin]) => [
				id,
				{
					...ruin,
					age: 0,
				},
			])),
			corpses: Object.fromEntries(Object.entries(snapshot.corpses).map(([id, corpse]) => [
				id,
				{
					...corpse,
					hp: 0,
					maxHp: 1,
					remaining: 1,
				},
			])),
			visibility: null,
			dayNight: dayNightStateAt(0),
			leaderboard: [],
			notices: [],
				hornSounds: [],
				soundDebug: null,
				pathDebug: false,
				pathAvailabilityDebug: false,
				unitTileDebug: false,
				serverPerf: null,
				admin: null,
				statistics: null,
		});
	}

	previewTimeOfDay(progress: number) {
		const currentProgress = this.state.snapshot?.dayNight.cycleProgress ?? 0;
		this.state.timeOffsetSeconds += (progress - currentProgress) * DAY_NIGHT_CYCLE_SECONDS;
		if (this.state.snapshot) this.state.snapshot.dayNight = this.offsetDayNight(this.state.snapshot.dayNight);
	}

	clearTimeOffset() {
		this.state.timeOffsetSeconds = 0;
	}

	resetSequence() {
		this.lastSeq = 0;
	}

	private mergeDelta(previous: ClientSnapshot, delta: SnapshotDelta): Snapshot {
		return {
			type: "snapshot",
			seq: delta.seq,
			now: delta.now,
			playerId: delta.playerId,
			map: previous.map,
			players: this.patchRecord(previous.players, delta.players),
			units: this.patchRecord(previous.units, delta.units),
			buildings: this.patchRecord(Object.fromEntries(Object.entries(previous.buildings).map(([id, building]) => [id, building.serialize()])), delta.buildings),
			resources: this.patchRecord(previous.resources, delta.resources),
			ruins: this.patchRecord(previous.ruins, delta.ruins),
			corpses: this.patchRecord(previous.corpses, delta.corpses),
			visibility: delta.visibility,
			dayNight: delta.dayNight,
			leaderboard: delta.leaderboard,
			notices: delta.notices,
				hornSounds: delta.hornSounds,
				soundDebug: delta.soundDebug,
				pathDebug: delta.pathDebug,
				pathAvailabilityDebug: delta.pathAvailabilityDebug,
				unitTileDebug: delta.unitTileDebug,
				serverPerf: delta.serverPerf !== undefined ? delta.serverPerf : previous.serverPerf,
				admin: delta.admin !== undefined ? delta.admin : previous.admin,
				statistics: delta.statistics !== undefined ? delta.statistics : previous.statistics,
		};
	}

	private patchRecord<T>(previous: Record<string, T>, delta: { updated: Record<string, T>; removed: string[] }): Record<string, T> {
		const next = { ...previous };
		for (const id of delta.removed) delete next[id];
		for (const [id, value] of Object.entries(delta.updated)) next[id] = value as T;
		return next;
	}

	private offsetDayNight(dayNight: ClientSnapshot["dayNight"]) {
		if (!this.state.timeOffsetSeconds) return dayNight;
		return dayNightStateAt(dayNight.cycleProgress * DAY_NIGHT_CYCLE_SECONDS + this.state.timeOffsetSeconds);
	}
}
