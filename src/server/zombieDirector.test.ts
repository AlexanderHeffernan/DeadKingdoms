import assert from "node:assert/strict";
import test from "node:test";
import { MAP_SIZE } from "../shared/config.js";
import { buildSoundField, soundFieldCellAt } from "../shared/soundField.js";
import type { Unit, World, ZombieHorde } from "../shared/types.js";
import { stepZombieDirector } from "./zombieDirector.js";
import { ZOMBIE_OWNER_ID } from "./zombieSpawning.js";

const EXPECTED_SOUND_MEMORY_FOLLOW_DISTANCE = 18;

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

function addZombieCluster(world: World, x: number, y: number, count: number, idPrefix: string) {
	for (let i = 0; i < count; i += 1) {
		const unit = makeZombie(x + (i % 5) * 0.1, y + Math.floor(i / 5) * 0.1, `${idPrefix}-${i}`);
		world.units[unit.id] = unit;
	}
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

function hordeContaining(world: World, unit: Unit): ZombieHorde {
	const horde = Object.values(world._zombieHordes || {}).find((candidate) => candidate.memberIds.includes(unit.id));
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

function assertProjectedSoundTarget(horde: ZombieHorde) {
	assert.ok(horde.soundMemory);
	assert.ok(horde.target);
	assertClose(horde.target.x, horde.center.x + horde.soundMemory.direction.x * EXPECTED_SOUND_MEMORY_FOLLOW_DISTANCE);
	assertClose(horde.target.y, horde.center.y + horde.soundMemory.direction.y * EXPECTED_SOUND_MEMORY_FOLLOW_DISTANCE);
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
	assertProjectedSoundTarget(onlyHorde(world));

	world.actionNoises = [];
	step(world);

	const horde = onlyHorde(world);
	assert.ok(horde.soundMemory);
	assertSameDirection(horde.soundMemory.direction, rememberedDirection);
	assertProjectedSoundTarget(horde);
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
	assertProjectedSoundTarget(horde);
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
	assertProjectedSoundTarget(horde);
	assert.equal(horde.soundMemory.significance, 0.01);
});

test("zombie hordes keep walking past the remembered sound origin", () => {
	const world = makeWorld();
	const zombie = makeZombie();
	world.units[zombie.id] = zombie;
	addNoise(world, 121, 121, 1.2);

	step(world);
	const oldProjectedTarget = onlyHorde(world).target;
	const firstDirection = onlyHorde(world).soundMemory?.direction;
	assert.ok(oldProjectedTarget);
	assert.ok(firstDirection);

	world.actionNoises = [];
	zombie.x = oldProjectedTarget.x;
	zombie.y = oldProjectedTarget.y;
	step(world);

	const horde = onlyHorde(world);
	assert.ok(horde.target);
	assertSameDirection(horde.soundMemory!.direction, firstDirection);
	assertProjectedSoundTarget(horde);
	assert.ok(horde.target.x > oldProjectedTarget.x);
	assert.ok(horde.target.y > oldProjectedTarget.y);
});

test("zombie hordes without memory can follow zombie noise", () => {
	const world = makeWorld();
	const listener = makeZombie();
	world.units[listener.id] = listener;
	addZombieCluster(world, 129, 129, 100, "neighbor-zombie");

	step(world);

	const horde = hordeContaining(world, listener);
	assert.ok(horde.soundMemory);
	assertProjectedSoundTarget(horde);
	const target = horde.target;
	assert.ok(target);
	assert.ok(target.x > listener.x);
	assert.ok(target.y > listener.y);
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
	assertProjectedSoundTarget(horde);
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

test("zombie hordes keep stronger memory when a weaker sound is heard", () => {
	const world = makeWorld();
	world.units["z-test" as Unit["id"]] = makeZombie();
	addNoise(world, 121, 121, 8);

	step(world);
	const firstMemory = onlyHorde(world).soundMemory;
	assert.ok(firstMemory);
	const firstDirection = { ...firstMemory.direction };

	world.actionNoises = [];
	step(world);
	addNoise(world, 126, 126, 1.2, "weak-noise");
	step(world);

	const memory = onlyHorde(world).soundMemory;
	assert.ok(memory);
	assertSameDirection(memory.direction, firstDirection);
	assert.ok(memory.significance > 1.2);
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
