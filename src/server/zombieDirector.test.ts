import assert from "node:assert/strict";
import test from "node:test";
import { MAP_SIZE } from "../shared/config.js";
import { buildSoundField, soundFieldCellAt } from "../shared/soundField.js";
import type { Unit, World, ZombieHorde } from "../shared/types.js";
import { stepWorld } from "./world.js";
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

test("world tick lets zombies hear one-tick action sounds before they expire", () => {
	const world = makeWorld();
	const zombie = makeZombie(120, 120);
	world.units[zombie.id] = zombie;
	world.actionNoises = [{ id: "short-sound", action: "unitAttack", x: 124, y: 120, sound: 60, remaining: 0.1 }];

	stepWorld(world, 0.1);

	const horde = onlyHorde(world);
	assert.equal(world.actionNoises.length, 0);
	assert.ok(horde.soundMemory);
	assertClose(horde.soundMemory.target.x, 124);
	assertClose(horde.soundMemory.target.y, 120);
	assert.ok(zombie.hordeTarget);
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

test("zombies in the same horde receive stable spread targets around the horde target", () => {
	const world = makeWorld();
	const first = makeZombie(120, 120, "z-first");
	const second = makeZombie(120.4, 120, "z-second");
	world.units[first.id] = first;
	world.units[second.id] = second;

	step(world);

	assert.equal(first.hordeId, second.hordeId);
	assert.ok(first.hordeTarget);
	assert.ok(second.hordeTarget);
	assert.ok(first.zombieHordeSourceTarget);
	assert.deepEqual(first.zombieHordeSourceTarget, second.zombieHordeSourceTarget);
	assert.notDeepEqual(first.hordeTarget, second.hordeTarget);
	assert.ok(Math.hypot(first.hordeTarget.x - second.hordeTarget.x, first.hordeTarget.y - second.hordeTarget.y) > 0.05);
	assert.ok(Math.hypot(first.hordeTarget.x - first.zombieHordeSourceTarget.x, first.hordeTarget.y - first.zombieHordeSourceTarget.y) < 1.3);
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
	assert.ok(drifting.hordeTarget);
	assert.ok(joining.hordeTarget);
	assert.ok(drifting.zombieHordeSourceTarget);
	assert.deepEqual(drifting.zombieHordeSourceTarget, joining.zombieHordeSourceTarget);
	assert.notDeepEqual(drifting.hordeTarget, joining.hordeTarget);
	assert.ok(drifting.hordeTarget.x > 60);
});

test("joining zombie adopts the larger horde direction instead of overriding it", () => {
	const world = makeWorld();
	const largeMembers: Unit[] = [];
	for (let i = 0; i < 8; i += 1) {
		const zombie = makeZombie(70 + i * 0.2, 80, `large-drift-${i}`);
		zombie.hordeId = "large";
		world.units[zombie.id] = zombie;
		largeMembers.push(zombie);
	}
	const joining = makeZombie(72, 80, "joining-with-old-sound");
	joining.hordeId = "small";
	world.units[joining.id] = joining;
	world._zombieHordes = {
		large: {
			id: "large",
			memberIds: largeMembers.map((unit) => unit.id),
			center: { x: 70.7, y: 80 },
			radius: 4,
			target: { x: 92, y: 80 },
			targetMemory: 0,
			wanderTarget: null,
			targetKind: "drift",
			driftDirection: { x: 1, y: 0 },
			soundMemory: null,
		},
		small: {
			id: "small",
			memberIds: [joining.id],
			center: { x: 72, y: 80 },
			radius: 1.5,
			target: { x: 50, y: 80 },
			targetMemory: 0,
			wanderTarget: null,
			targetKind: "sound",
			driftDirection: null,
			soundMemory: {
				direction: { x: -1, y: 0 },
				target: { x: 50, y: 80 },
				significance: 8,
				age: 0,
			},
		},
	};
	world.tick = 7;

	step(world);

	const horde = onlyHorde(world);
	assert.equal(horde.id, "large");
	assert.equal(horde.targetKind, "drift");
	assert.equal(horde.soundMemory, null);
	assert.ok(horde.driftDirection);
	assert.ok(horde.driftDirection.x > 0);
	assert.ok(joining.zombieHordeSourceTarget);
	assert.ok(joining.zombieHordeSourceTarget.x > 80);
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
	const positions = [
		{ x: 63.5, y: 64 },
		{ x: 66, y: 64 },
		{ x: 68.5, y: 64 },
		{ x: 69, y: 64.4 },
		{ x: 69.4, y: 63.6 },
		{ x: 69.7, y: 64.2 },
		{ x: 70, y: 63.8 },
		{ x: 70.2, y: 64.4 },
	];
	for (let i = 0; i < positions.length; i += 1) {
		const position = positions[i]!;
		const zombie = makeZombie(position.x, position.y, `edge-listener-${i}`);
		world.units[zombie.id] = zombie;
	}
	addNoise(world, 60, 64, 8);

	step(world);

	const horde = onlyHorde(world);
	assert.ok(horde.center.x >= 68);
	assert.ok(horde.soundMemory);
	assertClose(horde.soundMemory.target.x, 60);
	assertClose(horde.soundMemory.target.y, 64);
	assertRememberedSoundTarget(horde);
});

test("long zombie chains split into local hordes instead of one mega horde", () => {
	const world = makeWorld();
	for (let i = 0; i < 22; i += 1) {
		const zombie = makeZombie(40 + i * 2.8, 80, `chain-zombie-${i}`);
		world.units[zombie.id] = zombie;
	}

	step(world);

	const hordes = Object.values(world._zombieHordes || {});
	const first = world.units["chain-zombie-0" as Unit["id"]];
	const last = world.units["chain-zombie-21" as Unit["id"]];
	assert.ok(first);
	assert.ok(last);
	assert.ok(hordes.length >= 4);
	assert.notEqual(first.hordeId, last.hordeId);
	for (const horde of hordes) {
		const members = horde.memberIds.map((memberId) => world.units[memberId]).filter((unit): unit is Unit => !!unit);
		const maxDistanceFromCenter = Math.max(...members.map((member) => Math.hypot(member.x - horde.center.x, member.y - horde.center.y)));
		assert.ok(maxDistanceFromCenter <= 6);
	}
});

test("splitting a previous mega horde keeps unique horde records for every cohort", () => {
	const world = makeWorld();
	const members: Unit[] = [];
	for (let i = 0; i < 22; i += 1) {
		const zombie = makeZombie(40 + i * 2.8, 80, `old-chain-zombie-${i}`);
		zombie.hordeId = "old-mega";
		world.units[zombie.id] = zombie;
		members.push(zombie);
	}
	world._zombieHordes = {
		"old-mega": {
			id: "old-mega",
			memberIds: members.map((unit) => unit.id),
			center: { x: 70, y: 80 },
			radius: 9,
			target: { x: 100, y: 80 },
			targetMemory: 0,
			wanderTarget: null,
			targetKind: "sound",
			driftDirection: null,
			soundMemory: {
				direction: { x: 1, y: 0 },
				target: { x: 100, y: 80 },
				significance: 4,
				age: 1,
			},
		},
	};
	world.tick = 7;

	step(world);

	const hordes = Object.values(world._zombieHordes || {});
	const assignedMemberIds = new Set(hordes.flatMap((horde) => horde.memberIds));
	assert.ok(hordes.length >= 4);
	assert.equal(assignedMemberIds.size, members.length);
	assert.equal(hordes.filter((horde) => horde.id === "old-mega").length, 1);
	for (const zombie of members) {
		assert.ok(zombie.hordeId);
		const horde = world._zombieHordes?.[zombie.hordeId];
		assert.ok(horde);
		assert.ok(horde.memberIds.includes(zombie.id));
		assert.ok(zombie.zombieHordeSourceTarget);
	}
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
	assert.deepEqual(listener.zombieHordeSourceTarget, { x: 52.6, y: 80 });
	assert.deepEqual(unsampledNeighbor.zombieHordeSourceTarget, listener.zombieHordeSourceTarget);
	assert.ok(listener.hordeTarget);
	assert.ok(unsampledNeighbor.hordeTarget);
	assert.notDeepEqual(unsampledNeighbor.hordeTarget, listener.hordeTarget);
});

test("one joining listener does not redirect a larger horde from its existing sound", () => {
	const world = makeWorld();
	for (let i = 0; i < 24; i += 1) {
		const zombie = makeZombie(80 + (i % 6) * 0.2, 80 + Math.floor(i / 6) * 0.2, `large-horde-${i}`);
		zombie.hordeId = "big";
		world.units[zombie.id] = zombie;
	}
	const joiner = makeZombie(82.5, 80, "joining-listener");
	joiner.hordeId = "small";
	world.units[joiner.id] = joiner;
	world._zombieHordes = {
		big: {
			id: "big",
			memberIds: Object.values(world.units).filter((unit) => unit.id !== joiner.id).map((unit) => unit.id),
			center: { x: 80.5, y: 80.3 },
			radius: 4,
			target: { x: 110, y: 80 },
			targetMemory: 0,
			wanderTarget: null,
			targetKind: "sound",
			driftDirection: null,
			soundMemory: {
				direction: { x: 1, y: 0 },
				target: { x: 110, y: 80 },
				significance: 4,
				age: 1,
			},
		},
		small: {
			id: "small",
			memberIds: [joiner.id],
			center: { x: 82.5, y: 80 },
			radius: 1.5,
			target: { x: 60, y: 80 },
			targetMemory: 0,
			wanderTarget: null,
			targetKind: "sound",
			driftDirection: null,
			soundMemory: null,
		},
	};
	addNoise(world, 60, 80, 8, "joiner-only-noise");
	world.tick = 7;

	step(world);

	const horde = onlyHorde(world);
	const member = world.units["large-horde-0" as Unit["id"]];
	assert.ok(member);
	assert.ok(horde.soundMemory);
	assertClose(horde.soundMemory.target.x, 110);
	assertClose(horde.soundMemory.target.y, 80);
	assert.ok(member.zombieHordeSourceTarget);
	assertClose(member.zombieHordeSourceTarget.x, 110);
	assertClose(member.zombieHordeSourceTarget.y, 80);
});

test("one listener can redirect a larger horde for a dev bang", () => {
	const world = makeWorld();
	for (let i = 0; i < 24; i += 1) {
		const zombie = makeZombie(80 + (i % 6) * 0.2, 80 + Math.floor(i / 6) * 0.2, `dev-bang-horde-${i}`);
		zombie.hordeId = "big";
		world.units[zombie.id] = zombie;
	}
	const listener = makeZombie(82.5, 80, "dev-bang-listener");
	listener.hordeId = "small";
	world.units[listener.id] = listener;
	world._zombieHordes = {
		big: {
			id: "big",
			memberIds: Object.values(world.units).filter((unit) => unit.id !== listener.id).map((unit) => unit.id),
			center: { x: 80.5, y: 80.3 },
			radius: 4,
			target: { x: 110, y: 80 },
			targetMemory: 0,
			wanderTarget: null,
			targetKind: "sound",
			driftDirection: null,
			soundMemory: {
				direction: { x: 1, y: 0 },
				target: { x: 110, y: 80 },
				significance: 4,
				age: 1,
			},
		},
		small: {
			id: "small",
			memberIds: [listener.id],
			center: { x: 82.5, y: 80 },
			radius: 1.5,
			target: { x: 60, y: 80 },
			targetMemory: 0,
			wanderTarget: null,
			targetKind: "sound",
			driftDirection: null,
			soundMemory: null,
		},
	};
	world.actionNoises = [{ id: "dev-bang", action: "devBang", x: 60, y: 80, sound: 13333.333333333334, remaining: 2.5 }];
	world.tick = 7;

	step(world);

	const horde = onlyHorde(world);
	assert.ok(horde.soundMemory);
	assertClose(horde.soundMemory.target.x, 60);
	assertClose(horde.soundMemory.target.y, 80);
	assert.ok(listener.zombieHordeSourceTarget);
	assertClose(listener.zombieHordeSourceTarget.x, 60);
	assertClose(listener.zombieHordeSourceTarget.y, 80);
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
	assert.ok(first.hordeTarget);
	assert.ok(second.hordeTarget);
	assert.ok(first.zombieHordeSourceTarget);
	assert.deepEqual(first.zombieHordeSourceTarget, second.zombieHordeSourceTarget);
	assert.notDeepEqual(first.hordeTarget, second.hordeTarget);
	assert.ok(Math.hypot(first.hordeTarget.x - 50, first.hordeTarget.y - 80) > 1.5);
	assert.notDeepEqual(first.zombieHordeSourceTarget, { x: 50, y: 80 });
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
