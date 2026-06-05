import assert from "node:assert/strict";
import test from "node:test";
import { MAP_SIZE } from "../shared/config.js";
import type { Unit, World } from "../shared/types.js";
import { findPath, isWalkable } from "./pathing.js";

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
    id: "u-test" as Unit["id"],
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
