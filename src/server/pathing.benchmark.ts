import { performance } from "node:perf_hooks";
import { MAP_SIZE } from "../shared/config.js";
import type { Unit, World } from "../shared/types.js";
import { findPath, findSharedPath, moveWithPath, resolveUnitSeparation } from "./pathing.js";

type PathRequest = {
	unit: Unit;
	target: { x: number; y: number };
};

type BenchmarkCase = {
	name: string;
	repeats: number;
	requests: PathRequest[];
	world: World;
	shared?: boolean;
	crowd?: number;
};

type BenchmarkResult = {
	name: string;
	paths: number;
	totalMs: number;
	averageMs: number;
	pathsPerSecond: number;
	averagePathLength: number;
	emptyPaths: number;
};

type SeparationBenchmarkCase = {
	name: string;
	repeats: number;
	makeWorld: () => World;
};

type MovementBenchmarkCase = {
	name: string;
	repeats: number;
	makeWorld: () => World;
};

type MovementBenchmarkResult = {
	name: string;
	repeats: number;
	units: number;
	totalMs: number;
	averageMs: number;
	unitsPerSecond: number;
};

type SeparationBenchmarkResult = {
	name: string;
	repeats: number;
	units: number;
	totalMs: number;
	averageMs: number;
	unitsPerSecond: number;
};

function main() {
	const pathCases = [
		openFieldSinglePath(),
		blockedDestinationSinglePath(),
		wallGapSinglePath(),
		mazeSinglePath(),
		clusteredGroupMove(),
		clusteredGroupSharedMove(),
		clusteredCrowdSharedMove(),
		scatteredGroupMove(),
	];
	const separationCases = [
		separationTwoUnitsSameCell(),
		separationTwoUnitsNeighboringCells(),
		separation500UnitsSpread(),
		separation500UnitsClustered(),
		separation1000UnitsSpread(),
		separation1000UnitsClustered(),
	];
	const movementCases = [
		arrival800UnitsNearGroupEdge(),
	];

	printPathResults(pathCases.map(runPathBenchmark));
	console.log("");
	printSeparationResults(separationCases.map(runSeparationBenchmark));
	console.log("");
	printMovementResults(movementCases.map(runMovementBenchmark));
}

function runPathBenchmark(testCase: BenchmarkCase): BenchmarkResult {
	for (let i = 0; i < Math.min(5, testCase.repeats); i += 1) {
		for (const request of testCase.requests) findBenchmarkPath(testCase, request);
	}

	let totalPathLength = 0;
	let emptyPaths = 0;
	const paths = testCase.requests.length * testCase.repeats;
	const start = performance.now();

	for (let i = 0; i < testCase.repeats; i += 1) {
		for (const request of testCase.requests) {
			const path = findBenchmarkPath(testCase, request);
			totalPathLength += path.length;
			if (path.length === 0) emptyPaths += 1;
		}
	}

	const totalMs = performance.now() - start;
	return {
		name: testCase.name,
		paths,
		totalMs,
		averageMs: totalMs / paths,
		pathsPerSecond: (paths / totalMs) * 1000,
		averagePathLength: totalPathLength / paths,
		emptyPaths,
	};
}

function findBenchmarkPath(testCase: BenchmarkCase, request: PathRequest) {
	return testCase.shared ? findSharedPath(testCase.world, request.unit, request.target, undefined, testCase.crowd ?? 1) : findPath(testCase.world, request.unit, request.target);
}

function runSeparationBenchmark(testCase: SeparationBenchmarkCase): SeparationBenchmarkResult {
	for (let i = 0; i < Math.min(5, testCase.repeats); i += 1) resolveUnitSeparation(testCase.makeWorld());

	let unitCount = 0;
	const start = performance.now();
	for (let i = 0; i < testCase.repeats; i += 1) {
		const world = testCase.makeWorld();
		unitCount = Object.keys(world.units).length;
		resolveUnitSeparation(world);
	}
	const totalMs = performance.now() - start;
	return {
		name: testCase.name,
		repeats: testCase.repeats,
		units: unitCount,
		totalMs,
		averageMs: totalMs / testCase.repeats,
		unitsPerSecond: ((unitCount * testCase.repeats) / totalMs) * 1000,
	};
}

function runMovementBenchmark(testCase: MovementBenchmarkCase): MovementBenchmarkResult {
	for (let i = 0; i < Math.min(5, testCase.repeats); i += 1) stepMovingUnits(testCase.makeWorld());

	let unitCount = 0;
	const start = performance.now();
	for (let i = 0; i < testCase.repeats; i += 1) {
		const world = testCase.makeWorld();
		unitCount = stepMovingUnits(world);
	}
	const totalMs = performance.now() - start;
	return {
		name: testCase.name,
		repeats: testCase.repeats,
		units: unitCount,
		totalMs,
		averageMs: totalMs / testCase.repeats,
		unitsPerSecond: ((unitCount * testCase.repeats) / totalMs) * 1000,
	};
}

function stepMovingUnits(world: World): number {
	let count = 0;
	for (const unit of Object.values(world.units)) {
		if (unit.command.type !== "move") continue;
		moveWithPath(world, unit, unit.command, 0.32);
		count += 1;
	}
	return count;
}

function openFieldSinglePath(): BenchmarkCase {
	return {
		name: "open field, single long path",
		repeats: 250,
		world: makeWorld(),
		requests: [{ unit: makeUnit(8.5, 8.5), target: { x: 220.5, y: 220.5 } }],
	};
}

function blockedDestinationSinglePath(): BenchmarkCase {
	return {
		name: "blocked destination, nearest walkable",
		repeats: 250,
		world: makeWorld(rect(218, 218, 5, 5)),
		requests: [{ unit: makeUnit(180.5, 220.5), target: { x: 220.5, y: 220.5 } }],
	};
}

function wallGapSinglePath(): BenchmarkCase {
	const blocked = [];
	for (let y = 16; y <= 230; y += 1) {
		if (y < 119 || y > 125) blocked.push({ x: 128, y });
	}

	return {
		name: "wall with narrow gap",
		repeats: 180,
		world: makeWorld(blocked),
		requests: [{ unit: makeUnit(32.5, 120.5), target: { x: 224.5, y: 120.5 } }],
	};
}

function mazeSinglePath(): BenchmarkCase {
	const blocked = [];
	for (let x = 32; x <= 216; x += 8) {
		const gapY = x % 16 === 0 ? 48 : 208;
		for (let y = 32; y <= 224; y += 1) {
			if (Math.abs(y - gapY) > 4) blocked.push({ x, y });
		}
	}

	return {
		name: "alternating maze corridors",
		repeats: 80,
		world: makeWorld(blocked),
		requests: [{ unit: makeUnit(16.5, 128.5), target: { x: 240.5, y: 128.5 } }],
	};
}

function clusteredGroupMove(): BenchmarkCase {
	const requests = [];
	for (let i = 0; i < 80; i += 1) {
		requests.push({
			unit: makeUnit(24.5 + (i % 10), 24.5 + Math.floor(i / 10)),
			target: { x: 210.5 + (i % 3) * 0.25, y: 210.5 + Math.floor(i / 3) * 0.25 },
		});
	}

	return {
		name: "80-unit clustered move",
		repeats: 8,
		world: makeWorld(),
		requests,
	};
}

function clusteredGroupSharedMove(): BenchmarkCase {
	const requests = [];
	for (let i = 0; i < 80; i += 1) {
		requests.push({
			unit: makeUnit(24.5 + (i % 10), 24.5 + Math.floor(i / 10)),
			target: { x: 210.5, y: 210.5 },
		});
	}

	return {
		name: "80-unit clustered shared move",
		repeats: 8,
		world: makeWorld(),
		requests,
		shared: true,
	};
}

function clusteredCrowdSharedMove(): BenchmarkCase {
	return {
		...clusteredGroupSharedMove(),
		name: "80-unit clustered crowd-aware move",
		shared: true,
		crowd: 80,
	};
}

function scatteredGroupMove(): BenchmarkCase {
	const requests = [];
	for (let i = 0; i < 80; i += 1) {
		requests.push({
			unit: makeUnit(8.5 + (i % 10) * 18, 8.5 + Math.floor(i / 10) * 18),
			target: { x: 230.5 - (i % 10) * 2, y: 230.5 - Math.floor(i / 10) * 2 },
		});
	}

	return {
		name: "80-unit scattered move",
		repeats: 8,
		world: makeWorld(),
		requests,
	};
}

function separationTwoUnitsSameCell(): SeparationBenchmarkCase {
	return {
		name: "2 units same cell",
		repeats: 5000,
		makeWorld: () => worldWithUnits([makeUnit(10.4, 10.5, "sep-a"), makeUnit(10.6, 10.5, "sep-b")]),
	};
}

function separationTwoUnitsNeighboringCells(): SeparationBenchmarkCase {
	return {
		name: "2 units neighboring cells",
		repeats: 5000,
		makeWorld: () => worldWithUnits([makeUnit(10.9, 10.5, "sep-a"), makeUnit(11.1, 10.5, "sep-b")]),
	};
}

function separation500UnitsSpread(): SeparationBenchmarkCase {
	return {
		name: "500 units spread",
		repeats: 120,
		makeWorld: () => worldWithUnits(spreadUnits(500)),
	};
}

function separation500UnitsClustered(): SeparationBenchmarkCase {
	return {
		name: "500 units clustered",
		repeats: 120,
		makeWorld: () => worldWithUnits(clusteredUnits(500)),
	};
}

function separation1000UnitsSpread(): SeparationBenchmarkCase {
	return {
		name: "1000 units spread",
		repeats: 60,
		makeWorld: () => worldWithUnits(spreadUnits(1000)),
	};
}

function separation1000UnitsClustered(): SeparationBenchmarkCase {
	return {
		name: "1000 units clustered",
		repeats: 60,
		makeWorld: () => worldWithUnits(clusteredUnits(1000)),
	};
}

function arrival800UnitsNearGroupEdge(): MovementBenchmarkCase {
	return {
		name: "800 moving units checking group arrival",
		repeats: 80,
		makeWorld: () => {
			const world = makeWorld();
			const target = { x: 160.5, y: 160.5 };
			const arrived = clusteredUnits(120).map((unit, index) => {
				unit.id = `arrived-${index}` as Unit["id"];
				unit.x = target.x + (index % 12) * 0.18;
				unit.y = target.y + Math.floor(index / 12) * 0.18;
				unit.command = { type: "idle" };
				return unit;
			});
			const moving = clusteredUnits(800).map((unit, index) => {
				unit.id = `moving-${index}` as Unit["id"];
				unit.x = target.x + 2.2 + (index % 40) * 0.12;
				unit.y = target.y + Math.floor(index / 40) * 0.12;
				unit.command = { type: "move", ...target, path: [{ x: target.x, y: target.y }], pathCrowd: 800 };
				return unit;
			});
			for (const unit of [...arrived, ...moving]) world.units[unit.id] = unit;
			return world;
		},
	};
}

function worldWithUnits(units: Unit[]) {
	const world = makeWorld();
	for (const unit of units) world.units[unit.id] = unit;
	return world;
}

function spreadUnits(count: number): Unit[] {
	const units = [];
	for (let i = 0; i < count; i += 1) {
		const x = 4.5 + ((i * 17) % (MAP_SIZE - 8));
		const y = 4.5 + ((Math.floor(i / 15) * 13 + i * 3) % (MAP_SIZE - 8));
		units.push(makeUnit(x, y, `spread-${i}`));
	}
	return units;
}

function clusteredUnits(count: number): Unit[] {
	const units = [];
	const columns = Math.ceil(Math.sqrt(count));
	for (let i = 0; i < count; i += 1) {
		const x = 120 + (i % columns) * 0.22;
		const y = 120 + Math.floor(i / columns) * 0.22;
		units.push(makeUnit(x, y, `cluster-${i}`));
	}
	return units;
}

function makeWorld(blocked: Array<{ x: number; y: number }> = []): World {
	const occupancy = new Uint8Array(MAP_SIZE * MAP_SIZE);
	for (const tile of blocked) {
		if (tile.x >= 0 && tile.y >= 0 && tile.x < MAP_SIZE && tile.y < MAP_SIZE) {
			occupancy[tile.y * MAP_SIZE + tile.x] = 1;
		}
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

function makeUnit(x: number, y: number, id = `u-${x}-${y}`): Unit {
	return {
		id: id as Unit["id"],
		kind: "unit",
		type: "villager",
		ownerId: "p-benchmark" as Unit["ownerId"],
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

function rect(x: number, y: number, width: number, height: number) {
	const blocked = [];
	for (let dy = 0; dy < height; dy += 1) {
		for (let dx = 0; dx < width; dx += 1) {
			blocked.push({ x: x + dx, y: y + dy });
		}
	}
	return blocked;
}

function printPathResults(results: BenchmarkResult[]) {
	console.log("Pathfinding benchmark");
	console.log("=====================");
	for (const result of results) {
		console.log(
			[
				result.name.padEnd(36),
				`${result.paths.toString().padStart(5)} paths`,
				`${result.totalMs.toFixed(1).padStart(8)} ms total`,
				`${result.averageMs.toFixed(3).padStart(7)} ms/path`,
				`${Math.round(result.pathsPerSecond).toString().padStart(6)} paths/s`,
				`${result.averagePathLength.toFixed(1).padStart(6)} avg nodes`,
				`${result.emptyPaths.toString().padStart(4)} empty`,
			].join("  "),
		);
	}
}

function printSeparationResults(results: SeparationBenchmarkResult[]) {
	console.log("Unit separation benchmark");
	console.log("=========================");
	for (const result of results) {
		console.log(
			[
				result.name.padEnd(36),
				`${result.repeats.toString().padStart(5)} ticks`,
				`${result.units.toString().padStart(5)} units`,
				`${result.totalMs.toFixed(1).padStart(8)} ms total`,
				`${result.averageMs.toFixed(3).padStart(7)} ms/tick`,
				`${Math.round(result.unitsPerSecond).toString().padStart(8)} units/s`,
			].join("  "),
		);
	}
}

function printMovementResults(results: MovementBenchmarkResult[]) {
	console.log("Movement benchmark");
	console.log("==================");
	for (const result of results) {
		console.log(
			[
				result.name.padEnd(36),
				`${result.repeats.toString().padStart(5)} ticks`,
				`${result.units.toString().padStart(5)} units`,
				`${result.totalMs.toFixed(1).padStart(8)} ms total`,
				`${result.averageMs.toFixed(3).padStart(7)} ms/tick`,
				`${Math.round(result.unitsPerSecond).toString().padStart(8)} units/s`,
			].join("  "),
		);
	}
}

main();
