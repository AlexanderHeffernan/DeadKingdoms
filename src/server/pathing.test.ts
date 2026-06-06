import assert from "node:assert/strict";
import test from "node:test";
import { MAP_SIZE } from "../shared/config.js";
import type { Unit, World } from "../shared/types.js";
import { findPath, isWalkable, moveAroundSmallObstacle, resolveUnitSeparation } from "./pathing.js";

function makeWorld(blocked: Array<{ x: number; y: number }> = []): World {
	const occupancy = new Uint8Array(MAP_SIZE * MAP_SIZE);
	for (const tile of blocked) {
		occupancy[tile.y * MAP_SIZE + tile.x] = 1;
	}
	return {
		map: { size: MAP_SIZE },
		players: {},
		units: {},
		buildings: {},
		resources: {},
		ruins: {},
		notices: [],
		adminLogs: [],
		actionNoises: [],
		leaderboard: [],
		tick: 0,
		spawnTimers: {},
		serverPerf: { tps: 10, tickMs: 0, samples: [] },
		_occupancy: occupancy,
	};
}

function makeUnit(x: number, y: number, id = "u-test"): Unit {
	return {
		id: id as Unit["id"],
		kind: "unit",
		type: "villager",
		ownerId: "p-test" as Unit["ownerId"],
		x,
		y,
		hp: 40,
		maxHp: 40,
		command: { type: "idle" },
		cooldown: 0,
		attackFlash: 0,
		workFlash: 0,
		facing: "right",
		carried: null,
		selected: false,
	};
}

function addUnits(world: World, units: Unit[]) {
	for (const unit of units) world.units[unit.id] = unit;
}

test("findPath returns a direct path on an open map", () => {
	const world = makeWorld();
	const path = findPath(world, makeUnit(4.5, 4.5), { x: 12.5, y: 4.5 });

	assert.ok(path.length > 0);
	assert.deepEqual(path.at(-1), { x: 12.5, y: 4.5 });
});

test("findPath routes around a wall with a gap", () => {
	const blocked = [];
	for (let y = 2; y <= 16; y += 1) {
		if (y !== 9) blocked.push({ x: 8, y });
	}
	const world = makeWorld(blocked);
	const path = findPath(world, makeUnit(4.5, 9.5), { x: 14.5, y: 9.5 });

	assert.ok(path.length > 0);
	assert.ok(path.some((point) => Math.floor(point.x) === 8 && Math.floor(point.y) === 9));
	for (const point of path) {
		assert.equal(isWalkable(world, Math.floor(point.x), Math.floor(point.y)), true);
	}
});

test("findPath targets the nearest walkable tile around a blocked destination", () => {
	const world = makeWorld([{ x: 20, y: 20 }]);
	const path = findPath(world, makeUnit(15.5, 20.5), { x: 20.5, y: 20.5 });

	assert.ok(path.length > 0);
	assert.notDeepEqual(path.at(-1), { x: 20.5, y: 20.5 });
	assert.equal(isWalkable(world, Math.floor(path.at(-1)!.x), Math.floor(path.at(-1)!.y)), true);
});

test("findPath returns an empty path for an out-of-map destination", () => {
	const world = makeWorld();
	const path = findPath(world, makeUnit(10.5, 10.5), { x: -20, y: -20 });

	assert.equal(path.length, 0);
});

test("resolveUnitSeparation pushes overlapping units in the same grid cell apart", () => {
	const world = makeWorld();
	const a = makeUnit(10.4, 10.5, "u-a");
	const b = makeUnit(10.6, 10.5, "u-b");
	addUnits(world, [a, b]);

	resolveUnitSeparation(world);

	assert.ok(distanceBetween(a, b) >= 0.47);
	assert.ok(a.x < 10.4);
	assert.ok(b.x > 10.6);
});

test("resolveUnitSeparation checks neighboring grid cells", () => {
	const world = makeWorld();
	const a = makeUnit(10.9, 10.5, "u-a");
	const b = makeUnit(11.1, 10.5, "u-b");
	addUnits(world, [a, b]);

	resolveUnitSeparation(world);

	assert.ok(distanceBetween(a, b) >= 0.47);
	assert.ok(a.x < 10.9);
	assert.ok(b.x > 11.1);
});

test("resolveUnitSeparation leaves distant units untouched", () => {
	const world = makeWorld();
	const a = makeUnit(10.5, 10.5, "u-a");
	const b = makeUnit(18.5, 18.5, "u-b");
	addUnits(world, [a, b]);

	resolveUnitSeparation(world);

	assert.equal(a.x, 10.5);
	assert.equal(a.y, 10.5);
	assert.equal(b.x, 18.5);
	assert.equal(b.y, 18.5);
});

test("resolveUnitSeparation does not move a single unit by comparing it with itself", () => {
	const world = makeWorld();
	const unit = makeUnit(10.5, 10.5, "u-a");
	addUnits(world, [unit]);

	resolveUnitSeparation(world);

	assert.equal(unit.x, 10.5);
	assert.equal(unit.y, 10.5);
});

test("moveAroundSmallObstacle sidesteps an isolated blocked tile", () => {
	const world = makeWorld([{ x: 11, y: 10 }]);
	const unit = makeUnit(10.5, 10.5, "u-a");

	const blocked = moveAroundSmallObstacle(world, unit, { x: 14.5, y: 10.5 }, 1);

	assert.equal(blocked, false);
	assert.notEqual(unit.y, 10.5);
	assert.equal(isWalkable(world, Math.floor(unit.x), Math.floor(unit.y)), true);
});

test("moveAroundSmallObstacle escapes when a unit starts inside an occupied tile", () => {
	const world = makeWorld([{ x: 10, y: 10 }]);
	const unit = makeUnit(10.5, 10.5, "u-a");

	const blocked = moveAroundSmallObstacle(world, unit, { x: 14.5, y: 10.5 }, 1);

	assert.equal(blocked, false);
	assert.equal(isWalkable(world, Math.floor(unit.x), Math.floor(unit.y)), true);
});

test("moveAroundSmallObstacle does not path around a wall-like blockage", () => {
	const world = makeWorld([
		{ x: 11, y: 9 },
		{ x: 11, y: 10 },
		{ x: 11, y: 11 },
	]);
	const unit = makeUnit(10.5, 10.5, "u-a");

	const blocked = moveAroundSmallObstacle(world, unit, { x: 14.5, y: 10.5 }, 1);

	assert.equal(blocked, true);
	assert.equal(unit.x, 10.5);
	assert.equal(unit.y, 10.5);
});

function distanceBetween(a: Unit, b: Unit) {
	return Math.hypot(a.x - b.x, a.y - b.y);
}
