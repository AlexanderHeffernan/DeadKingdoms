import assert from "node:assert/strict";
import test from "node:test";
import { MAP_SIZE } from "../shared/config.js";
import type { ResourceNode, Unit, UnitCommand, World } from "../shared/types.js";
import { ZombieUnit, type UnitSimulationContext } from "../shared/units/index.js";
import { findPath, findSharedPath, isWalkable, moveAroundSmallObstacle, moveNearTarget, moveWithPath, moveZombieWithPath, resolveUnitSeparation, ZOMBIE_PATH_LOOKAHEAD_DISTANCE } from "./pathing.js";

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
	const path = findPath(world, makeUnit(4, 4), { x: 12, y: 4 });

	assert.ok(path.length > 0);
	assert.deepEqual(path.at(-1), { x: 12, y: 4 });
});

test("findPath routes around a wall with a gap", () => {
	const blocked = [];
	for (let y = 2; y <= 16; y += 1) {
		if (y !== 9) blocked.push({ x: 8, y });
	}
	const world = makeWorld(blocked);
	const path = findPath(world, makeUnit(4, 9), { x: 14, y: 9 });

	assert.ok(path.length > 0);
	assert.ok(path.some((point) => Math.floor(point.x) === 8 && Math.floor(point.y) === 9));
	for (const point of path) {
		assert.equal(isWalkable(world, Math.floor(point.x), Math.floor(point.y)), true);
	}
});

test("findSharedPath reuses a destination field for nearby units", () => {
	const blocked = [];
	for (let y = 2; y <= 16; y += 1) {
		if (y !== 9) blocked.push({ x: 8, y });
	}
	const world = makeWorld(blocked);
	const target = { x: 14, y: 9 };
	const first = findSharedPath(world, makeUnit(4, 8), target);
	const second = findSharedPath(world, makeUnit(4, 10), target);

	assert.ok(first.length > 0);
	assert.ok(second.length > 0);
	assert.deepEqual(first.at(-1), { x: 14, y: 9 });
	assert.deepEqual(second.at(-1), { x: 14, y: 9 });
});

test("findSharedPath prefers a wider opening for very large crowds", () => {
	const blocked = [];
	for (let y = 2; y <= 28; y += 1) {
		if (y === 5 || (y >= 18 && y <= 24)) continue;
		blocked.push({ x: 18, y });
	}
	const world = makeWorld(blocked);
	const path = findSharedPath(world, makeUnit(10, 5), { x: 26, y: 5 }, MAP_SIZE, 220);

	assert.ok(path.some((point) => Math.floor(point.x) === 18 && Math.floor(point.y) >= 18 && Math.floor(point.y) <= 24));
});

test("findSharedPath can use a narrow opening for a small crowd", () => {
	const blocked = [];
	for (let y = 2; y <= 28; y += 1) {
		if (y === 5 || (y >= 18 && y <= 24)) continue;
		blocked.push({ x: 18, y });
	}
	const world = makeWorld(blocked);
	const path = findSharedPath(world, makeUnit(10, 5), { x: 26, y: 5 }, MAP_SIZE, 1);

	assert.ok(path.some((point) => Math.floor(point.x) === 18 && Math.floor(point.y) === 5));
});

test("findPath targets the nearest walkable tile around a blocked destination", () => {
	const world = makeWorld([{ x: 20, y: 20 }]);
	const path = findPath(world, makeUnit(15, 20), { x: 20, y: 20 });

	assert.ok(path.length > 0);
	assert.notDeepEqual(path.at(-1), { x: 20, y: 20 });
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

test("resolveUnitSeparation does not push moving units apart", () => {
	const world = makeWorld();
	const a = makeUnit(10.4, 10.5, "u-a");
	const b = makeUnit(10.7, 10.5, "u-b");
	a.command = { type: "move", x: 20.5, y: 10.5 };
	b.command = { type: "move", x: 20.5, y: 10.5 };
	addUnits(world, [a, b]);

	resolveUnitSeparation(world);

	assert.equal(a.x, 10.4);
	assert.equal(a.y, 10.5);
	assert.equal(b.x, 10.7);
	assert.equal(b.y, 10.5);
});

test("resolveUnitSeparation keeps idle units more spread apart", () => {
	const world = makeWorld();
	const a = makeUnit(10.4, 10.5, "u-a");
	const b = makeUnit(10.7, 10.5, "u-b");
	addUnits(world, [a, b]);

	resolveUnitSeparation(world);

	assert.ok(distanceBetween(a, b) >= 0.47);
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
	const unit = makeUnit(10, 10, "u-a");

	const blocked = moveAroundSmallObstacle(world, unit, { x: 14, y: 10 }, 1);

	assert.equal(blocked, false);
	assert.notEqual(unit.y, 10);
	assert.equal(isWalkable(world, Math.round(unit.x), Math.round(unit.y)), true);
});

test("moveAroundSmallObstacle keeps sliding past a tree corner", () => {
	const world = makeWorld([{ x: 10, y: 10 }]);
	const unit = makeUnit(9.49, 9.49, "u-corner");
	const target = { x: 12, y: 12 };
	let stalledTicks = 0;

	for (let tick = 0; tick < 60 && distanceBetween(unit, target) > 0.45; tick += 1) {
		const before = { x: unit.x, y: unit.y };
		moveAroundSmallObstacle(world, unit, target, 0.135);
		if (Math.hypot(unit.x - before.x, unit.y - before.y) < 0.001) stalledTicks += 1;
	}

	assert.equal(stalledTicks, 0);
	assert.ok(distanceBetween(unit, target) <= 0.45);
	assert.equal(isWalkable(world, Math.round(unit.x), Math.round(unit.y)), true);
});

test("moveZombieWithPath routes around a small cluster of trees", () => {
	const world = makeWorld([
		{ x: 10, y: 10 },
		{ x: 11, y: 10 },
	]);
	const zombie = makeUnit(8, 10, "z-cluster");
	zombie.type = "zombie";
	zombie.ownerId = "zombies" as Unit["ownerId"];
	const target = { x: 14, y: 10 };

	for (let tick = 0; tick < 80 && distanceBetween(zombie, target) > 0.45; tick += 1) {
		world.tick = tick + 1;
		moveZombieWithPath(world, zombie, target, 0.135);
	}

	assert.ok(zombie.x > 12);
	assert.ok(distanceBetween(zombie, target) <= ZOMBIE_PATH_LOOKAHEAD_DISTANCE);
	assert.equal(isWalkable(world, Math.round(zombie.x), Math.round(zombie.y)), true);
});

test("zombie movement escalates to pathing when sidesteps do not make progress", () => {
	const world = makeWorld();
	const zombie = makeUnit(8, 10, "z-progress-stuck");
	zombie.type = "zombie";
	zombie.ownerId = "zombies" as Unit["ownerId"];
	zombie.soundTarget = { x: 14, y: 10 };
	let sidestepCalls = 0;
	let pathCalls = 0;
	const behavior = new ZombieUnit();
	const context = {
		world,
		nearbyTargetUnits: () => [],
		centerOf: (entity: { x: number; y: number; size?: number }) => ({ x: entity.x + ((entity.size || 1) - 1) / 2, y: entity.y + ((entity.size || 1) - 1) / 2 }),
		distance: distanceBetween,
		moveAroundSmallObstacle: (unit: Unit) => {
			sidestepCalls += 1;
			unit.y += 0.04;
			return false;
		},
		moveZombieWithPath: (unit: Unit) => {
			pathCalls += 1;
			unit.x += 0.2;
			return false;
		},
	} as unknown as UnitSimulationContext;

	for (let tick = 0; tick < 4; tick += 1) behavior.step(context, zombie, 0.1);

	assert.equal(sidestepCalls, 3);
	assert.equal(pathCalls, 1);
	assert.equal(zombie.zombieStuckTicks, 0);
});

test("moveZombieWithPath does not solve a wall-length detour", () => {
	const world = makeWorld([
		{ x: 10, y: 7 },
		{ x: 10, y: 8 },
		{ x: 10, y: 9 },
		{ x: 10, y: 10 },
		{ x: 10, y: 11 },
		{ x: 10, y: 12 },
		{ x: 10, y: 13 },
	]);
	const zombie = makeUnit(8, 10, "z-wall");
	zombie.type = "zombie";
	zombie.ownerId = "zombies" as Unit["ownerId"];
	const target = { x: 16, y: 10 };

	for (let tick = 0; tick < 80; tick += 1) {
		world.tick = tick + 1;
		moveZombieWithPath(world, zombie, target, 0.135);
	}

	assert.ok(zombie.x < 10);
	assert.equal(isWalkable(world, Math.round(zombie.x), Math.round(zombie.y)), true);
});

test("moveAroundSmallObstacle escapes when a unit starts inside an occupied tile", () => {
	const world = makeWorld([{ x: 10, y: 10 }]);
	const unit = makeUnit(10, 10, "u-a");

	const blocked = moveAroundSmallObstacle(world, unit, { x: 14, y: 10 }, 1);

	assert.equal(blocked, false);
	assert.equal(isWalkable(world, Math.round(unit.x), Math.round(unit.y)), true);
});

test("moveAroundSmallObstacle does not path around a wall-like blockage", () => {
	const world = makeWorld([
		{ x: 11, y: 9 },
		{ x: 11, y: 10 },
		{ x: 11, y: 11 },
	]);
	const unit = makeUnit(10, 10, "u-a");

	const blocked = moveAroundSmallObstacle(world, unit, { x: 14, y: 10 }, 1);

	assert.equal(blocked, true);
	assert.equal(unit.x, 10);
	assert.equal(unit.y, 10);
});

test("moveAroundSmallObstacle lets moving units pass through idle friendly units", () => {
	const world = makeWorld([{ x: 11, y: 10 }]);
	const idle = makeUnit(11, 10, "u-idle");
	const moving = makeUnit(10, 10, "u-moving");
	moving.command = { type: "move", x: 12, y: 10, path: [{ x: 12, y: 10 }] };
	addUnits(world, [idle, moving]);

	const blocked = moveAroundSmallObstacle(world, moving, { x: 12, y: 10 }, 1);

	assert.equal(blocked, false);
	assert.equal(moving.x, 11);
	assert.equal(moving.y, 10);
});

test("moveAroundSmallObstacle still blocks resources under idle friendly units", () => {
	const world = makeWorld([{ x: 11, y: 10 }]);
	const resource: ResourceNode = {
		id: "r-tree" as ResourceNode["id"],
		kind: "resource",
		type: "tree",
		resource: "wood",
		x: 11,
		y: 10,
		amount: 100,
		maxAmount: 100,
	};
	world.resources[resource.id] = resource;
	const idle = makeUnit(11, 10, "u-idle");
	const moving = makeUnit(10, 10, "u-moving");
	moving.command = { type: "move", x: 14, y: 10, path: [{ x: 14, y: 10 }] };
	addUnits(world, [idle, moving]);

	const blocked = moveAroundSmallObstacle(world, moving, { x: 14, y: 10 }, 1);

	assert.equal(blocked, false);
	assert.notEqual(moving.x, 11);
});

test("moveWithPath does not consume a waypoint when blocked by an obstacle", () => {
	const world = makeWorld([{ x: 11, y: 10 }]);
	world.tick = 1;
	const unit = makeUnit(10, 10, "u-a");
	const command = {
		type: "move" as const,
		x: 14,
		y: 10,
		path: [
			{ x: 11, y: 10 },
			{ x: 12, y: 10 },
		],
	};

	moveWithPath(world, unit, command, 1);

	assert.notDeepEqual(command.path?.[0], { x: 12, y: 10 });
	assert.equal(unit.x, 10);
	assert.equal(unit.y, 10);
});

test("moveWithPath prunes stale reachable path nodes", () => {
	const world = makeWorld();
	world.tick = 1;
	const unit = makeUnit(10.5, 10.5, "u-a");
	const command = {
		type: "move" as const,
		x: 18.5,
		y: 10.5,
		pathCrowd: 20,
		path: [
			{ x: 10.5, y: 11.5 },
			{ x: 12.5, y: 10.5 },
			{ x: 14.5, y: 10.5 },
		],
	};

	moveWithPath(world, unit, command, 0.25);

	assert.notDeepEqual(command.path?.[0], { x: 10.5, y: 11.5 });
	assert.ok(unit.x > 10.5);
});

test("moveNearTarget approaches a blocked resource without walking into its tile", () => {
	const world = makeWorld([{ x: 11, y: 10 }]);
	world.tick = 1;
	const unit = makeUnit(9.5, 10.5, "u-gather");
	const command: Extract<UnitCommand, { type: "gather" }> = {
		type: "gather",
		targetId: "r-tree",
		resourceKind: "wood",
		path: null,
	};
	unit.command = command;
	addUnits(world, [unit]);

	const arrived = moveNearTarget(world, unit, command, { x: 11, y: 10 }, 1.1, 1);

	assert.equal(arrived, true);
	assert.ok(unit.x > 9.5);
	assert.equal(Math.floor(unit.x), 10);
	assert.equal(Math.floor(unit.y), 10);
	assert.notEqual(Math.floor(unit.x), 11);
});

test("moveNearTarget with no path does not fallback into a blocked resource center", () => {
	const world = makeWorld([{ x: 11, y: 10 }]);
	world.tick = 1;
	const unit = makeUnit(9.7, 10, "u-near-tree");
	const command: Extract<UnitCommand, { type: "gather" }> = {
		type: "gather",
		targetId: "r-tree",
		resourceKind: "wood",
		path: null,
	};
	unit.command = command;
	addUnits(world, [unit]);

	moveNearTarget(world, unit, command, { x: 11, y: 10 }, 1.1, 1);

	assert.equal(Math.floor(unit.x), 10);
	assert.equal(Math.floor(unit.y), 10);
	assert.ok(unit.x <= 10);
	assert.notEqual(Math.floor(unit.x), 11);
});

test("moveNearTarget exits a tight resource pocket through the open tile center", () => {
	const world = makeWorld([
		{ x: 9, y: 10 },
		{ x: 11, y: 10 },
		{ x: 9, y: 11 },
		{ x: 10, y: 11 },
		{ x: 11, y: 11 },
	]);
	world.tick = 1;
	const unit = makeUnit(10, 10, "u-pocket");
	const command: Extract<UnitCommand, { type: "gather" }> = {
		type: "gather",
		targetId: "r-target",
		resourceKind: "wood",
		path: null,
	};
	unit.command = command;
	addUnits(world, [unit]);

	moveNearTarget(world, unit, command, { x: 10, y: 8 }, 0.2, 1);

	assert.ok(unit.y < 10);
	assert.equal(Math.round(unit.x), 10);
	assert.equal(Math.round(unit.y), 9);
	assert.notEqual(command.path, null);
});

test("moveWithPath follows a centered one-tile gap between resources", () => {
	const world = makeWorld([
		{ x: 9, y: 10 },
		{ x: 11, y: 10 },
		{ x: 9, y: 11 },
		{ x: 10, y: 11 },
		{ x: 11, y: 11 },
	]);
	world.tick = 1;
	const unit = makeUnit(10, 10, "u-gap");
	const command: Extract<UnitCommand, { type: "move" }> = {
		type: "move",
		x: 10,
		y: 8,
		path: [
			{ x: 10, y: 9 },
			{ x: 10, y: 8 },
		],
		pathCrowd: 1,
	};
	unit.command = command;
	addUnits(world, [unit]);

	moveWithPath(world, unit, command, 0.5);

	assert.ok(unit.y < 10);
	assert.equal(Math.round(unit.x), 10);
	assert.equal(Math.round(unit.y), 10);
	assert.notEqual(command.path, null);
});

test("single-unit move follows the next path node without sidestepping off path", () => {
	const world = makeWorld([{ x: 11, y: 10 }]);
	const resource: ResourceNode = {
		id: "r-tree" as ResourceNode["id"],
		kind: "resource",
		type: "tree",
		resource: "wood",
		x: 11,
		y: 10,
		amount: 100,
		maxAmount: 100,
	};
	world.resources[resource.id] = resource;
	world.tick = 1;
	const unit = makeUnit(10, 10, "u-single-tight");
	const command: Extract<UnitCommand, { type: "move" }> = {
		type: "move",
		x: 12,
		y: 10,
		path: [
			{ x: 11, y: 10 },
			{ x: 12, y: 10 },
		],
		pathCrowd: 1,
	};
	unit.command = command;
	addUnits(world, [unit]);

	moveWithPath(world, unit, command, 1);

	assert.equal(unit.x, 10);
	assert.equal(unit.y, 10);
	assert.equal(command.path, null);
});

test("gather path follows the next path node without lookahead or spacing offsets", () => {
	const world = makeWorld();
	world.tick = 1;
	const unit = makeUnit(10, 10, "u-gather-tight");
	const blocker = makeUnit(10.3, 10, "u-nearby-moving");
	const command: Extract<UnitCommand, { type: "gather" }> = {
		type: "gather",
		targetId: "r-tree",
		resourceKind: "wood",
		path: [
			{ x: 10, y: 9 },
			{ x: 10, y: 8 },
		],
		pathCrowd: 20,
	};
	unit.command = command;
	blocker.command = { type: "move", x: 18, y: 10, path: [{ x: 18, y: 10 }], pathCrowd: 20 };
	addUnits(world, [unit, blocker]);

	moveNearTarget(world, unit, command, { x: 10, y: 8 }, 0.2, 0.5);

	assert.equal(unit.x, 10);
	assert.ok(unit.y < 10);
	assert.ok(unit.y > 9);
	assert.deepEqual(command.path?.[0], { x: 10, y: 9 });
});

test("moveWithPath accepts joining an arrived group edge", () => {
	const world = makeWorld();
	const arrived = makeUnit(20.8, 20.5, "u-arrived");
	arrived.command = { type: "idle" };
	const joining = makeUnit(21.3, 20.5, "u-joining");
	const command = { type: "move" as const, x: 20.5, y: 20.5, path: null, pathCrowd: 30, formationTarget: { x: 21.5, y: 20.5 } };
	joining.command = command;
	addUnits(world, [arrived, joining]);

	const done = moveWithPath(world, joining, command, 0.25);

	assert.equal(done, true);
	assert.equal(joining.x, 21.3);
});

test("moveWithPath requires the first group unit to reach the exact target", () => {
	const world = makeWorld();
	const unit = makeUnit(22.0, 20.5, "u-first");
	const command = { type: "move" as const, x: 20.5, y: 20.5, path: null, pathCrowd: 30 };
	unit.command = command;
	addUnits(world, [unit]);

	const done = moveWithPath(world, unit, command, 0.25);

	assert.equal(done, false);
	assert.ok(unit.x < 22.0);
});

test("moveWithPath uses the real target even when it is unexplored", () => {
	const world = makeWorld();
	world.players["p-test"] = {
		id: "p-test",
		name: "Tester",
		color: "#ffffff",
		resources: { wood: 0, food: 0, ore: 0 },
		autoReplenishFarms: true,
		explored: new Set([4 * MAP_SIZE + 4]),
		population: 1,
		popCap: 10,
		defeated: false,
		score: 0,
		joinedAt: Date.now(),
	};
	const unit = makeUnit(4, 4, "u-scout");
	const command: Extract<UnitCommand, { type: "move" }> = { type: "move", x: 20, y: 4, path: null, pathCrowd: 1 };
	unit.command = command;
	addUnits(world, [unit]);

	moveWithPath(world, unit, command, 0.25);

	assert.deepEqual(command.path?.at(-1), { x: 20, y: 4 });
});

test("moveWithPath lets formation slots settle away from the clicked center", () => {
	const world = makeWorld();
	const unit = makeUnit(22.0, 21.5, "u-slot");
	const command: Extract<UnitCommand, { type: "move" }> = {
		type: "move",
		x: 20.5,
		y: 20.5,
		path: null,
		pathCrowd: 20,
		formationTarget: { x: 22.0, y: 21.5 },
	};
	unit.command = command;
	addUnits(world, [unit]);

	const done = moveWithPath(world, unit, command, 0.25);

	assert.equal(done, true);
	assert.equal(unit.x, 22.0);
	assert.equal(unit.y, 21.5);
});

test("moveWithPath follows the shared group path before deploying to a formation target", () => {
	const world = makeWorld();
	const unit = makeUnit(4, 4, "u-slot-path");
	const command: Extract<UnitCommand, { type: "move" }> = {
		type: "move",
		x: 20,
		y: 4,
		path: null,
		pathCrowd: 80,
		formationTarget: { x: 20.5, y: 20.5 },
	};
	unit.command = command;
	addUnits(world, [unit]);

	moveWithPath(world, unit, command, 0.25);

	assert.deepEqual(command.path?.at(-1), { x: 20, y: 4 });
});

test("moveWithPath walks toward formation slots instead of teleporting", () => {
	const world = makeWorld();
	const unit = makeUnit(20.5, 4.5, "u-slot-walk");
	const command: Extract<UnitCommand, { type: "move" }> = {
		type: "move",
		x: 20.5,
		y: 4.5,
		path: null,
		pathCrowd: 80,
		formationTarget: { x: 20.5, y: 20.5 },
	};
	unit.command = command;
	addUnits(world, [unit]);

	const done = moveWithPath(world, unit, command, 0.25);

	assert.equal(done, false);
	assert.equal(unit.x, 20.5);
	assert.ok(unit.y > 4.5);
	assert.ok(unit.y <= 4.75);
});

test("resolveUnitSeparation spreads units after they become idle at destination", () => {
	const world = makeWorld();
	const a = makeUnit(20.5, 20.5, "u-a");
	const b = makeUnit(20.55, 20.5, "u-b");
	a.command = { type: "idle" };
	b.command = { type: "idle" };
	addUnits(world, [a, b]);

	resolveUnitSeparation(world);

	assert.ok(distanceBetween(a, b) >= 0.47);
});

function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }) {
	return Math.hypot(a.x - b.x, a.y - b.y);
}
