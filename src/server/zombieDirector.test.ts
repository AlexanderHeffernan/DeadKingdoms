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
	addNoise(world, 121, 121, 4.8);

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
	addNoise(world, 121, 121, 1.2);

	step(world);
	assert.ok(onlyHorde(world).soundMemory);

	world.actionNoises = [];
	for (let i = 0; i < 25; i += 1) step(world);

	const horde = onlyHorde(world);
	assert.ok(horde.soundMemory);
	assert.equal(horde.soundMemory.significance, 0.01);
	assertRememberedSoundTarget(horde);
	assert.ok(world.units["z-test" as Unit["id"]]?.soundTarget);
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

test("zombie hordes remember the sound origin instead of walking forever past it", () => {
	const world = makeWorld();
	const zombie = makeZombie();
	world.units[zombie.id] = zombie;
	addNoise(world, 121, 121, 1.2);

	step(world);
	const rememberedTarget = onlyHorde(world).target;
	const firstDirection = onlyHorde(world).soundMemory?.direction;
	assert.ok(rememberedTarget);
	assert.ok(firstDirection);

	world.actionNoises = [];
	zombie.x = rememberedTarget.x;
	zombie.y = rememberedTarget.y;
	step(world);

	const horde = onlyHorde(world);
	assert.ok(horde.target);
	assertSameDirection(horde.soundMemory!.direction, firstDirection);
	assertRememberedSoundTarget(horde);
	assertClose(horde.target.x, rememberedTarget.x);
	assertClose(horde.target.y, rememberedTarget.y);
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
	assert.ok(zombie.wanderTarget);
	assert.equal(zombie.soundTarget ?? null, null);
});

test("zombie hordes do not replace remembered world sound with zombie-only noise", () => {
	const world = makeWorld();
	const zombie = makeZombie();
	world.units[zombie.id] = zombie;
	addNoise(world, 121, 121, 1.2);

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
		const zombie = makeZombie(100 + i * 5, 100 + i * 5, `line-zombie-${i}`);
		world.units[zombie.id] = zombie;
	}
	addNoise(world, 104, 104, 2000);

	step(world);

	const horde = onlyHorde(world);
	assert.ok(horde.center.x > 125);
	assert.ok(horde.soundMemory);
	assert.ok(horde.soundMemory.direction.x < 0);
	assert.ok(horde.soundMemory.direction.y < 0);
	assertRememberedSoundTarget(horde);
});

test("individual zombies hear nearby action sounds even when horde sampling would miss them", () => {
	const world = makeWorld();
	for (let i = 0; i < 18; i += 1) {
		const zombie = makeZombie(40 + i * 5, 80, `line-zombie-${i}`);
		world.units[zombie.id] = zombie;
	}
	addNoise(world, 50, 80, 8, "local-noise");

	step(world);

	const listener = world.units["line-zombie-2" as Unit["id"]];
	const unsampledNeighbor = world.units["line-zombie-4" as Unit["id"]];
	assert.ok(listener);
	assert.ok(unsampledNeighbor);
	assert.equal(listener.zombieGoalKind, "sound");
	assert.deepEqual(listener.soundTarget, { x: 50, y: 80 });
	assert.notDeepEqual(unsampledNeighbor.soundTarget, { x: 50, y: 80 });
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
