import test from "node:test";
import assert from "node:assert/strict";
import { dayNightStateAt } from "../shared/dayNight.js";
import { makeSnapshotDelta } from "./http.js";
import type { Snapshot } from "../shared/types.js";

test("snapshot delta sends changed, new, and removed visible entities", () => {
	const previous = makeTestSnapshot({
		units: {
			u1: testUnit("u1", 10, 10),
			u2: testUnit("u2", 20, 20),
		},
	});
	const current = makeTestSnapshot({
		units: {
			u1: testUnit("u1", 11, 10),
			u3: testUnit("u3", 30, 30),
		},
	});

	const delta = makeSnapshotDelta(previous, current, 4, 5);

	assert.equal(delta.baseSeq, 4);
	assert.equal(delta.seq, 5);
	assert.deepEqual(Object.keys(delta.units.updated).sort(), ["u1", "u3"]);
	assert.deepEqual(delta.units.removed, ["u2"]);
});

test("snapshot delta omits unchanged visible entities", () => {
	const unit = testUnit("u1", 10, 10);
	const previous = makeTestSnapshot({ units: { u1: unit } });
	const current = makeTestSnapshot({ units: { u1: { ...unit } } });

	const delta = makeSnapshotDelta(previous, current, 1, 2);

	assert.deepEqual(delta.units.updated, {});
	assert.deepEqual(delta.units.removed, []);
});

function makeTestSnapshot(overrides: Partial<Snapshot>): Snapshot {
	return {
		type: "snapshot",
		seq: 1,
		now: 1000,
		playerId: "p1",
		map: { size: 256 },
		players: {},
		units: {},
		buildings: {},
		resources: {},
		ruins: {},
		corpses: {},
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
		...overrides,
	};
}

function testUnit(id: string, x: number, y: number) {
	return {
		id,
		kind: "unit" as const,
		type: "villager" as const,
		ownerId: "p1",
		x,
		y,
		hp: 10,
		maxHp: 10,
		command: { type: "idle" as const },
		cooldown: 0,
		attackFlash: 0,
		workFlash: 0,
		facing: "right" as const,
		carried: null,
		selected: false,
	};
}
