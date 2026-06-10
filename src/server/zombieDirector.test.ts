import assert from "node:assert/strict";
import test from "node:test";
import { MAP_SIZE } from "../shared/config.js";
import { buildSoundField, soundFieldCellAt } from "../shared/soundField.js";
import type { Unit, World, ZombieHorde } from "../shared/types.js";
import { stepZombieDirector } from "./zombieDirector.js";
import { ZOMBIE_OWNER_ID } from "./zombieSpawning.js";

function makeWorld(): World {
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
		_occupancy: new Uint8Array(MAP_SIZE * MAP_SIZE),
	};
}

function makeZombie(x = 120, y = 120, id = "z-test"): Unit {
	return {
		id: id as Unit["id"],
		kind: "unit",
		type: "zombie",
		ownerId: ZOMBIE_OWNER_ID,
		x,
		y,
		hp: 34,
		maxHp: 34,
		command: { type: "idle" },
		cooldown: 0,
		attackFlash: 0,
		workFlash: 0,
		facing: "right",
		carried: null,
		selected: false,
	};
}

function addNoise(world: World, x: number, y: number, sound: number, id = "noise") {
	world.actionNoises = [{ id, action: "test", x, y, sound, remaining: 999 }];
}

function appendNoise(world: World, x: number, y: number, sound: number, id = "noise") {
	world.actionNoises.push({ id, action: "test", x, y, sound, remaining: 999 });
}

function addZombieCluster(world: World, x: number, y: number, count: number, idPrefix: string) {
	for (let i = 0; i < count; i += 1) {
		const unit = makeZombie(x + (i % 5) * 0.1, y + Math.floor(i / 5) * 0.1, `${idPrefix}-${i}`);
		world.units[unit.id] = unit;
	}
}

function makeTargetUnit(x = 121, y = 121, id = "target-test"): Unit {
	const unit = makeZombie(x, y, id);
	unit.type = "villager";
	unit.ownerId = "p-test" as Unit["ownerId"];
	return unit;
}

function step(world: World, dt = 1) {
	world.tick += 1;
	stepZombieDirector(world, dt);
}

function onlyHorde(world: World): ZombieHorde {
	const horde = Object.values(world._zombieHordes || {})[0];
	assert.ok(horde);
	return horde;
}

function assertClose(actual: number, expected: number, epsilon = 0.0001) {
	assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} should be close to ${expected}`);
}

function assertSameDirection(actual: { x: number; y: number }, expected: { x: number; y: number }) {
	assertClose(actual.x, expected.x);
	assertClose(actual.y, expected.y);
}

function assertRememberedSoundTarget(horde: ZombieHorde) {
	assert.ok(horde.soundMemory);
	assert.ok(horde.target);
	assertClose(horde.target.x, horde.soundMemory.target.x);
	assertClose(horde.target.y, horde.soundMemory.target.y);
}

test("zombie hordes remember a sound after it stops", () => {
	const world = makeWorld();
	world.units["z-test" as Unit["id"]] = makeZombie();
	addNoise(world, 124, 124, 4.8);

	step(world);
	const remembered = onlyHorde(world).soundMemory;
	assert.ok(remembered);
	const rememberedDirection = { ...remembered.direction };
	const rememberedSignificance = remembered.significance;
	assertRememberedSoundTarget(onlyHorde(world));

	world.actionNoises = [];
	step(world);

	const horde = onlyHorde(world);
	assert.ok(horde.soundMemory);
	assertSameDirection(horde.soundMemory.direction, rememberedDirection);
	assertRememberedSoundTarget(horde);
	assert.ok(horde.soundMemory.significance < rememberedSignificance);
});

test("zombie hordes keep following remembered sound at minimum significance", () => {
	const world = makeWorld();
	world.units["z-test" as Unit["id"]] = makeZombie();
	addNoise(world, 124, 124, 1.2);

	step(world);
	assert.ok(onlyHorde(world).soundMemory);

	world.actionNoises = [];
	for (let i = 0; i < 25; i += 1) step(world);

	const horde = onlyHorde(world);
	assert.ok(horde.soundMemory);
	assert.equal(horde.soundMemory.significance, 0.01);
	assertRememberedSoundTarget(horde);
	assert.ok(world.units["z-test" as Unit["id"]]?.hordeTarget);
});

test("zombie hordes do not replace sound memory with their own later noise", () => {
	const world = makeWorld();
	const zombie = makeZombie();
	world.units[zombie.id] = zombie;
	addNoise(world, 121, 121, 1.2);

	step(world);
	const firstDirection = onlyHorde(world).soundMemory?.direction;
	assert.ok(firstDirection);

	world.actionNoises = [];
	zombie.x = 160;
	zombie.y = 160;
	for (let i = 0; i < 30; i += 1) step(world);

	const horde = onlyHorde(world);
	assert.ok(horde.soundMemory);
	assertSameDirection(horde.soundMemory.direction, firstDirection);
	assertRememberedSoundTarget(horde);
	assert.equal(horde.soundMemory.significance, 0.01);
});

test("zombie hordes drift together after reaching remembered sound", () => {
	const world = makeWorld();
	const zombie = makeZombie();
	world.units[zombie.id] = zombie;
	addNoise(world, 124, 124, 1.2);

	step(world);
	const rememberedTarget = onlyHorde(world).target;
	const rememberedDirection = onlyHorde(world).soundMemory?.direction;
	assert.ok(rememberedTarget);
	assert.ok(rememberedDirection);

	world.actionNoises = [];
	zombie.x = rememberedTarget.x;
	zombie.y = rememberedTarget.y;
	step(world);

	const horde = onlyHorde(world);
	assert.equal(horde.soundMemory, null);
	assert.ok(horde.driftDirection);
	assertSameDirection(horde.driftDirection, rememberedDirection);
	assert.ok(horde.target);
	assert.equal(horde.targetKind, "drift");
	assert.ok(zombie.hordeTarget);
	assert.ok(Math.hypot(horde.center.x - horde.target.x, horde.center.y - horde.target.y) > 1.5);
});

test("zombie hordes drift around when they have not heard any sound", () => {
	const world = makeWorld();
	const zombie = makeZombie();
	world.units[zombie.id] = zombie;

	step(world);

	const horde = onlyHorde(world);
	assert.equal(horde.soundMemory, null);
	assert.equal(horde.target, null);
	assert.ok(horde.wanderTarget);
	assert.ok(zombie.hordeTarget);
	assert.equal(zombie.zombieGoalKind, "wander");
});

test("zombies in the same horde receive the same horde target", () => {
	const world = makeWorld();
	const first = makeZombie(120, 120, "z-first");
	const second = makeZombie(120.4, 120, "z-second");
	world.units[first.id] = first;
	world.units[second.id] = second;

	step(world);

	assert.equal(first.hordeId, second.hordeId);
	assert.ok(first.hordeTarget);
	assert.deepEqual(first.hordeTarget, second.hordeTarget);
	assert.equal(first.zombieGoalKind, second.zombieGoalKind);
});

test("merged hordes preserve drift momentum from any previous horde", () => {
	const world = makeWorld();
	const drifting = makeZombie(50, 80, "z-drifting");
	const joining = makeZombie(52, 80, "z-joining");
	world.units[drifting.id] = drifting;
	world.units[joining.id] = joining;
	world._zombieHordes = {
		"a": {
			id: "a" as ZombieHorde["id"],
			memberIds: [drifting.id],
			center: { x: 50, y: 80 },
			radius: 1.5,
			target: { x: 68, y: 80 },
			targetMemory: 0,
			wanderTarget: null,
			targetKind: "drift",
			driftDirection: { x: 1, y: 0 },
			soundMemory: null,
		},
		"b": {
			id: "b" as ZombieHorde["id"],
			memberIds: [joining.id],
			center: { x: 52, y: 80 },
			radius: 1.5,
			target: { x: 50, y: 80 },
			targetMemory: 0,
			wanderTarget: null,
			targetKind: "sound",
			driftDirection: null,
			soundMemory: null,
		},
	};
	drifting.hordeId = "a";
	joining.hordeId = "b";
	world.tick = 7;

	step(world);

	assert.equal(drifting.hordeId, joining.hordeId);
	assert.equal(drifting.zombieGoalKind, "drift");
	assert.deepEqual(drifting.hordeTarget, joining.hordeTarget);
	assert.ok(drifting.hordeTarget);
	assert.ok(drifting.hordeTarget.x > 60);
});

test("zombie hordes do not replace remembered world sound with zombie-only noise", () => {
	const world = makeWorld();
	const zombie = makeZombie();
	world.units[zombie.id] = zombie;
	addNoise(world, 124, 124, 1.2);

	step(world);
	const firstDirection = onlyHorde(world).soundMemory?.direction;
	assert.ok(firstDirection);

	world.actionNoises = [];
	addZombieCluster(world, 129, 129, 100, "neighbor-zombie");
	for (let i = 0; i < 30; i += 1) step(world);

	const horde = onlyHorde(world);
	assert.ok(horde.soundMemory);
	assertSameDirection(horde.soundMemory.direction, firstDirection);
	assertRememberedSoundTarget(horde);
	assert.equal(horde.soundMemory.significance, 0.01);
});

test("sound field tracks zombie noise by horde", () => {
	const field = buildSoundField([
		{ id: "z-a", kind: "zombie", label: "zombie", x: 121, y: 121, strength: 1.2, hordeId: "h-a" },
		{ id: "z-b", kind: "zombie", label: "zombie", x: 122, y: 122, strength: 3.6, hordeId: "h-b" },
	]);
	const cell = soundFieldCellAt(field, { x: 121, y: 121 });

	assert.ok(cell);
	assert.equal(cell.zombieStrengthByHorde["h-a"], 1.2);
	assert.equal(cell.zombieStrengthByHorde["h-b"], 3.6);
});

test("zombie hordes replace old memory with a more significant recent sound", () => {
	const world = makeWorld();
	world.units["z-test" as Unit["id"]] = makeZombie();
	addNoise(world, 121, 121, 8);

	step(world);
	const firstDirection = onlyHorde(world).soundMemory?.direction;
	assert.ok(firstDirection);

	world.actionNoises = [];
	for (let i = 0; i < 75; i += 1) step(world);

	addNoise(world, 126, 121, 4.8, "new-noise");
	step(world);

	const memory = onlyHorde(world).soundMemory;
	assert.ok(memory);
	assert.ok(memory.direction.x > firstDirection.x);
	assert.ok(memory.direction.y < firstDirection.y);
	assert.equal(memory.significance, 4.8);
});

test("zombie hordes replace capped loud memory with an equal fresh world sound", () => {
	const world = makeWorld();
	world.units["z-test" as Unit["id"]] = makeZombie();
	addNoise(world, 136, 121, 2000);

	step(world);
	const firstDirection = onlyHorde(world).soundMemory?.direction;
	assert.ok(firstDirection);

	addNoise(world, 104, 121, 2000, "equal-loud-noise");
	step(world);

	const memory = onlyHorde(world).soundMemory;
	assert.ok(memory);
	assert.ok(memory.direction.x < firstDirection.x);
	assert.equal(memory.significance, 8);
	assert.equal(memory.age, 0);
});

test("zombie hordes follow the newest audible bang instead of blended old bang direction", () => {
	const world = makeWorld();
	world.units["z-test" as Unit["id"]] = makeZombie();
	appendNoise(world, 136, 121, 2000, "old-bang");
	appendNoise(world, 104, 121, 2000, "new-bang");

	step(world);

	const memory = onlyHorde(world).soundMemory;
	assert.ok(memory);
	assert.ok(memory.direction.x < 0);
	assert.equal(memory.significance, 8);
});

test("zombie hordes prioritize loud bangs over nearby direct targets", () => {
	const world = makeWorld();
	world.units["z-test" as Unit["id"]] = makeZombie(120, 120);
	world.units["target-test" as Unit["id"]] = makeTargetUnit(121, 120);
	addNoise(world, 104, 120, 2000, "distracting-bang");

	step(world);

	const horde = onlyHorde(world);
	assert.ok(horde.soundMemory);
	assert.ok(horde.soundMemory.direction.x < 0);
	assertRememberedSoundTarget(horde);
});

test("zombie hordes hear loud sounds through member positions, not only their center", () => {
	const world = makeWorld();
	for (let i = 0; i < 16; i += 1) {
		const zombie = makeZombie(100 + i * 2, 100 + i * 2, `line-zombie-${i}`);
		world.units[zombie.id] = zombie;
	}
	addNoise(world, 105, 105, 2000);

	step(world);

	const horde = onlyHorde(world);
	assert.ok(horde.center.x > 110);
	assert.ok(horde.soundMemory);
	assert.ok(Math.hypot(horde.soundMemory.direction.x, horde.soundMemory.direction.y) > 0.9);
	assertRememberedSoundTarget(horde);
});

test("local action sounds unify the horde target", () => {
	const world = makeWorld();
	for (let i = 0; i < 18; i += 1) {
		const zombie = makeZombie(40 + i * 2.8, 80, `line-zombie-${i}`);
		world.units[zombie.id] = zombie;
	}
	addNoise(world, 52.6, 80, 8, "local-noise");

	step(world);

	const listener = world.units["line-zombie-4" as Unit["id"]];
	const unsampledNeighbor = world.units["line-zombie-5" as Unit["id"]];
	assert.ok(listener);
	assert.ok(unsampledNeighbor);
	assert.equal(listener.hordeId, unsampledNeighbor.hordeId);
	assert.equal(listener.zombieGoalKind, "sound");
	assert.deepEqual(listener.hordeTarget, { x: 52.6, y: 80 });
	assert.deepEqual(unsampledNeighbor.hordeTarget, listener.hordeTarget);
});

test("hordes flow through reached action sounds instead of stacking on them", () => {
	const world = makeWorld();
	for (let i = 0; i < 4; i += 1) {
		const zombie = makeZombie(50 + i * 2, 80, `flow-zombie-${i}`);
		world.units[zombie.id] = zombie;
	}
	addNoise(world, 50, 80, 8, "reached-local-noise");

	step(world);

	const first = world.units["flow-zombie-0" as Unit["id"]];
	const second = world.units["flow-zombie-1" as Unit["id"]];
	assert.ok(first);
	assert.ok(second);
	assert.equal(first.hordeId, second.hordeId);
	assert.equal(first.zombieGoalKind, "drift");
	assert.deepEqual(first.hordeTarget, second.hordeTarget);
	assert.ok(first.hordeTarget);
	assert.ok(Math.hypot(first.hordeTarget.x - 50, first.hordeTarget.y - 80) > 1.5);
	assert.notDeepEqual(first.hordeTarget, { x: 50, y: 80 });
});

test("zombie hordes replace stronger memory when a weaker world sound is heard", () => {
	const world = makeWorld();
	world.units["z-test" as Unit["id"]] = makeZombie();
	addNoise(world, 121, 121, 8);

	step(world);
	const firstMemory = onlyHorde(world).soundMemory;
	assert.ok(firstMemory);
	const firstDirection = firstMemory.direction;

	world.actionNoises = [];
	step(world);
	addNoise(world, 126, 120, 1.2, "weak-noise");
	step(world);

	const memory = onlyHorde(world).soundMemory;
	assert.ok(memory);
	assert.ok(memory.direction.x > firstDirection.x);
	assert.ok(memory.direction.y < firstDirection.y);
	assert.equal(memory.significance, 1.2);
});

test("zombie hordes replace loud memory with any audible fresh world sound", () => {
	const world = makeWorld();
	world.units["z-test" as Unit["id"]] = makeZombie();
	addNoise(world, 121, 121, 8);

	step(world);
	const firstMemory = onlyHorde(world).soundMemory;
	assert.ok(firstMemory);
	const firstDirection = firstMemory.direction;

	addNoise(world, 126, 120, 1.2, "small-fresh-noise");
	step(world);

	const memory = onlyHorde(world).soundMemory;
	assert.ok(memory);
	assert.ok(memory.direction.x > firstDirection.x);
	assert.ok(memory.direction.y < firstDirection.y);
	assert.equal(memory.significance, 1.2);
});

test("zombie hordes replace stale minimum memory with a tiny fresh sound", () => {
	const world = makeWorld();
	world.units["z-test" as Unit["id"]] = makeZombie();
	addNoise(world, 121, 121, 1.2);

	step(world);
	const firstDirection = onlyHorde(world).soundMemory?.direction;
	assert.ok(firstDirection);

	world.actionNoises = [];
	for (let i = 0; i < 25; i += 1) step(world);

	addNoise(world, 126, 121, 0.2, "tiny-fresh-noise");
	step(world);

	const memory = onlyHorde(world).soundMemory;
	assert.ok(memory);
	assert.ok(memory.direction.x > firstDirection.x);
	assert.ok(memory.direction.y < firstDirection.y);
	assert.ok(Math.abs(memory.significance - 0.2) < 0.0001);
});

test("zombie hordes replace old memory without a replacement threshold", () => {
	const world = makeWorld();
	world.units["z-test" as Unit["id"]] = makeZombie();
	addNoise(world, 121, 121, 8);

	step(world);
	const firstDirection = onlyHorde(world).soundMemory?.direction;
	assert.ok(firstDirection);

	world.actionNoises = [];
	for (let i = 0; i < 8; i += 1) step(world);

	addNoise(world, 126, 121, 0.2, "aged-memory-noise");
	step(world);

	const memory = onlyHorde(world).soundMemory;
	assert.ok(memory);
	assert.ok(memory.direction.x > firstDirection.x);
	assert.ok(memory.direction.y < firstDirection.y);
	assert.ok(Math.abs(memory.significance - 0.2) < 0.0001);
});
