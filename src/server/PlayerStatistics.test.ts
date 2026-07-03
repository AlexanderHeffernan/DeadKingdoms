import assert from "node:assert/strict";
import test from "node:test";
import { PlayerStatistics } from "./PlayerStatistics.js";
import { unitBehaviorFor } from "../shared/unitRegistry.js";

test("tracks military totals and population peaks", () => {
	const statistics = new PlayerStatistics();
	statistics.recordUnitCreated(unitBehaviorFor("soldier"));
	statistics.recordUnitCreated(unitBehaviorFor("soldier"));
	statistics.recordUnitCreated(unitBehaviorFor("villager"));
	statistics.recordUnitKilled();
	statistics.recordUnitRemoved(unitBehaviorFor("soldier"), true);
	statistics.recordBuildingRazed();
	statistics.recordBuildingLost();

	const report = statistics.snapshot();
	assert.equal(report.military.unitsKilled, 1);
	assert.equal(report.military.unitsLost, 1);
	assert.equal(report.military.buildingsRazed, 1);
	assert.equal(report.military.buildingsLost, 1);
	assert.equal(report.military.largestArmy, 2);
	assert.equal(report.economy.villagerHigh, 1);
});

test("tracks deposited resources by type", () => {
	const statistics = new PlayerStatistics();
	statistics.recordResourcesCollected("wood", 12);
	statistics.recordResourcesCollected("wood", 8);
	statistics.recordResourcesCollected("food", 5);

	assert.deepEqual(statistics.snapshot().economy.resourcesCollected, {
		wood: 20,
		food: 5,
		ore: 0,
	});
});

test("weights utilisation by villager time", () => {
	const statistics = new PlayerStatistics();
	statistics.recordUnitCreated(unitBehaviorFor("villager"));
	statistics.advance(10, 1);
	statistics.recordUnitCreated(unitBehaviorFor("villager"));
	statistics.advance(10, 0);

	assert.equal(statistics.snapshot().economy.villagerUtilisation, 2 / 3);
});

test("defeat cleanup does not count as combat loss", () => {
	const statistics = new PlayerStatistics();
	statistics.recordUnitCreated(unitBehaviorFor("soldier"));
	statistics.recordUnitRemoved(unitBehaviorFor("soldier"), false);

	assert.equal(statistics.snapshot().military.unitsLost, 0);
});

test("records score history in the final report", () => {
	const statistics = new PlayerStatistics();
	statistics.recordScore(125);
	statistics.finish();

	assert.equal(statistics.snapshot().scoreHistory.at(-1)?.score, 125);
});
