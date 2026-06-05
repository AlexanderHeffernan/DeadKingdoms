import { performance } from "node:perf_hooks";
import { ACTION_SOUND_DEFS, MAP_SIZE } from "../shared/config.js";
import type { Unit, World } from "../shared/types.js";
import { stepWorld } from "./world.js";
import { stepZombieDirector } from "./zombieDirector.js";
import { ZOMBIE_OWNER_ID } from "./zombieSpawning.js";

type BenchmarkCase = {
	name: string;
	repeats: number;
	world: World;
};

function main() {
	const cases = [
		{
			name: "500 spread zombies, quiet map",
			repeats: 1000,
			world: worldWithZombies(spreadZombies(500)),
		},
		{
			name: "500 clustered zombies, quiet map",
			repeats: 1000,
			world: worldWithZombies(clusteredZombies(500)),
		},
		{
			name: "500 spread zombies, active noise",
			repeats: 1000,
			world: worldWithZombies(spreadZombies(500), [{ x: 120, y: 120, sound: ACTION_SOUND_DEFS.build.sound }]),
		},
		{
			name: "1000 spread zombies, active noise",
			repeats: 600,
			world: worldWithZombies(spreadZombies(1000), [{ x: 120, y: 120, sound: ACTION_SOUND_DEFS.unitAttack.sound }]),
		},
	];

	printResults(cases.map(runBenchmark));
	console.log("");
	printWorldResults([
		runWorldBenchmark({
			name: "500 spread zombies, full world tick",
			repeats: 500,
			world: worldWithZombies(spreadZombies(500), [{ x: 120, y: 120, sound: ACTION_SOUND_DEFS.build.sound }]),
		}),
		runWorldBenchmark({
			name: "500 clustered zombies, full world tick",
			repeats: 500,
			world: worldWithZombies(clusteredZombies(500), [{ x: 120, y: 120, sound: ACTION_SOUND_DEFS.build.sound }]),
		}),
	]);
}

function runBenchmark(testCase: BenchmarkCase) {
	for (let i = 0; i < 10; i += 1) stepZombieDirector(testCase.world, 0.1);

	const start = performance.now();
	for (let i = 0; i < testCase.repeats; i += 1) {
		testCase.world.tick += 1;
		stepZombieDirector(testCase.world, 0.1);
	}
	const totalMs = performance.now() - start;
	const hordeCount = Object.keys(testCase.world._zombieHordes || {}).length;
	return {
		name: testCase.name,
		repeats: testCase.repeats,
		zombies: Object.keys(testCase.world.units).length,
		hordes: hordeCount,
		totalMs,
		averageMs: totalMs / testCase.repeats,
	};
}

function runWorldBenchmark(testCase: BenchmarkCase) {
	for (let i = 0; i < 10; i += 1) stepWorld(testCase.world, 0.1);

	const start = performance.now();
	for (let i = 0; i < testCase.repeats; i += 1) stepWorld(testCase.world, 0.1);
	const totalMs = performance.now() - start;
	return {
		name: testCase.name,
		repeats: testCase.repeats,
		zombies: Object.keys(testCase.world.units).length,
		hordes: Object.keys(testCase.world._zombieHordes || {}).length,
		totalMs,
		averageMs: totalMs / testCase.repeats,
	};
}

function worldWithZombies(zombies: Unit[], noises: Array<{ x: number; y: number; sound: number }> = []): World {
	const world = makeWorld();
	for (const zombie of zombies) world.units[zombie.id] = zombie;
	world.actionNoises = noises.map((noise, index) => ({
		id: `noise-${index}`,
		action: "benchmark",
		x: noise.x,
		y: noise.y,
		sound: noise.sound,
		remaining: 999,
	}));
	return world;
}

function spreadZombies(count: number): Unit[] {
	const units = [];
	for (let i = 0; i < count; i += 1) {
		const x = 4.5 + ((i * 17) % (MAP_SIZE - 8));
		const y = 4.5 + ((Math.floor(i / 15) * 13 + i * 3) % (MAP_SIZE - 8));
		units.push(makeZombie(x, y, `spread-zombie-${i}`));
	}
	return units;
}

function clusteredZombies(count: number): Unit[] {
	const units = [];
	const columns = Math.ceil(Math.sqrt(count));
	for (let i = 0; i < count; i += 1) {
		const x = 120 + (i % columns) * 0.55;
		const y = 120 + Math.floor(i / columns) * 0.55;
		units.push(makeZombie(x, y, `cluster-zombie-${i}`));
	}
	return units;
}

function makeWorld(): World {
	return {
		map: { size: MAP_SIZE },
		players: {},
		units: {},
		buildings: {},
		resources: {},
		ruins: {},
		notices: [],
		actionNoises: [],
		leaderboard: [],
		tick: 0,
		spawnTimers: {},
		serverPerf: { tps: 10, tickMs: 0 },
		_occupancy: new Uint8Array(MAP_SIZE * MAP_SIZE),
	};
}

function makeZombie(x: number, y: number, id: string): Unit {
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

function printResults(results: ReturnType<typeof runBenchmark>[]) {
	console.log("Zombie director benchmark");
	console.log("=========================");
	for (const result of results) {
		console.log(
			[
				result.name.padEnd(38),
				`${result.repeats.toString().padStart(5)} ticks`,
				`${result.zombies.toString().padStart(5)} zombies`,
				`${result.hordes.toString().padStart(5)} hordes`,
				`${result.totalMs.toFixed(1).padStart(8)} ms total`,
				`${result.averageMs.toFixed(4).padStart(8)} ms/tick`,
			].join("  "),
		);
	}
}

function printWorldResults(results: ReturnType<typeof runWorldBenchmark>[]) {
	console.log("Full zombie world tick benchmark");
	console.log("===============================");
	for (const result of results) {
		console.log(
			[
				result.name.padEnd(40),
				`${result.repeats.toString().padStart(5)} ticks`,
				`${result.zombies.toString().padStart(5)} zombies`,
				`${result.hordes.toString().padStart(5)} hordes`,
				`${result.totalMs.toFixed(1).padStart(8)} ms total`,
				`${result.averageMs.toFixed(4).padStart(8)} ms/tick`,
			].join("  "),
		);
	}
}

main();
