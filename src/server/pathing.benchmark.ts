import { performance } from "node:perf_hooks";
import { MAP_SIZE } from "../shared/config.js";
import type { Unit, World } from "../shared/types.js";
import { findPath } from "./pathing.js";

type PathRequest = {
  unit: Unit;
  target: { x: number; y: number };
};

type BenchmarkCase = {
  name: string;
  repeats: number;
  requests: PathRequest[];
  world: World;
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

function main() {
  const cases = [
    openFieldSinglePath(),
    blockedDestinationSinglePath(),
    wallGapSinglePath(),
    mazeSinglePath(),
    clusteredGroupMove(),
    scatteredGroupMove(),
  ];

  const results = cases.map(runBenchmark);
  printResults(results);
}

function runBenchmark(testCase: BenchmarkCase): BenchmarkResult {
  for (let i = 0; i < Math.min(5, testCase.repeats); i += 1) {
    for (const request of testCase.requests) findPath(testCase.world, request.unit, request.target);
  }

  let totalPathLength = 0;
  let emptyPaths = 0;
  const paths = testCase.requests.length * testCase.repeats;
  const start = performance.now();

  for (let i = 0; i < testCase.repeats; i += 1) {
    for (const request of testCase.requests) {
      const path = findPath(testCase.world, request.unit, request.target);
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
    actionNoises: [],
    leaderboard: [],
    tick: 0,
    spawnTimers: {},
    serverPerf: { tps: 10, tickMs: 0 },
    _occupancy: occupancy,
  };
}

function makeUnit(x: number, y: number): Unit {
  return {
    id: `u-${x}-${y}` as Unit["id"],
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

function printResults(results: BenchmarkResult[]) {
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

main();
