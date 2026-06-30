import test from "node:test";
import assert from "node:assert/strict";
import { addPlayer, command, createWorld, grantPlayerResource, stepWorld } from "./world.js";
import { MAP_SIZE } from "../shared/config.js";
import { createBuilding as createBuildingInstance } from "../shared/buildings/index.js";

test("worker counts update as villagers change commands", () => {
	const world = createWorld();
	const playerId = addPlayer(world, "Counter Test", "#ffffff");
	const player = world.players[playerId]!;
	const villagers = Object.values(world.units)
	.filter((unit) => unit.ownerId === playerId && unit.type === "villager")
	.sort((a, b) => a.id.localeCompare(b.id));
	const tree = Object.values(world.resources).find((resource) => resource.resource === "wood")!;

	assert.equal(player.workerCounts.idle, villagers.length);
	assert.equal(player.workerCounts.gathering.wood, 0);

	const gatherResult = command(world, playerId, {
		type: "gather",
		playerId,
		unitIds: [villagers[0]!.id],
		targetId: tree.id,
	});
	assert.equal(gatherResult.ok, true);
	assert.equal(player.workerCounts.idle, villagers.length - 1);
	assert.equal(player.workerCounts.gathering.wood, 1);

	const moveResult = command(world, playerId, {
		type: "move",
		playerId,
		unitIds: [villagers[0]!.id],
		x: villagers[0]!.x + 2,
		y: villagers[0]!.y,
	});
	assert.equal(moveResult.ok, true);
	assert.equal(player.workerCounts.idle, villagers.length - 1);
	assert.equal(player.workerCounts.gathering.wood, 0);

	stepWorld(world, 1);
	assert.ok(player.workerCounts.idle <= villagers.length);
});

test("dev resource grants add to player stockpiles", () => {
	const world = createWorld();
	const playerId = addPlayer(world, "Grant Test", "#ffffff");
	const player = world.players[playerId]!;

	const total = grantPlayerResource(world, playerId, "ore", 1000);

	assert.equal(total, player.resources.ore);
	assert.equal(player.resources.ore, 1150);
});

test("building placement updates occupancy and pathing version immediately", () => {
	const world = createWorld();
	const playerId = addPlayer(world, "Build Occupancy Test", "#ffffff");
	const villager = Object.values(world.units).find((unit) => unit.ownerId === playerId && unit.type === "villager")!;
	const placement = findBuildPlacement(world, villager.x, villager.y);
	const beforeVersion = world._pathing?.occupancyVersion ?? 0;

	const result = command(world, playerId, {
		type: "build",
		playerId,
		unitIds: [villager.id],
		buildingType: "wall",
		x: placement.x,
		y: placement.y,
	});

	assert.equal(result.ok, true);
	assert.equal(world._occupancy?.[placement.y * MAP_SIZE + placement.x], 1);
	assert.ok((world._pathing?.occupancyVersion ?? 0) > beforeVersion);
});

test("wall line placement batches occupancy invalidation", () => {
	const world = createWorld();
	const playerId = addPlayer(world, "Wall Line Batch Test", "#ffffff");
	const villager = Object.values(world.units).find((unit) => unit.ownerId === playerId && unit.type === "villager")!;
	grantPlayerResource(world, playerId, "ore", 1000);
	const tiles = findWallLinePlacement(world, 12);
	const beforeVersion = world._pathing?.occupancyVersion ?? 0;

	const result = command(world, playerId, {
		type: "buildWallLine",
		playerId,
		unitIds: [villager.id],
		tiles,
	});

	assert.equal(result.ok, true);
	assert.equal(result.placed, tiles.length);
	assert.equal((world._pathing?.occupancyVersion ?? 0) - beforeVersion, 1);
	for (const tile of tiles)
		assert.equal(world._occupancy?.[tile.y * MAP_SIZE + tile.x], 1);
});

test("depot gather command spreads villagers across nearby resources", () => {
	const world = createWorld();
	const playerId = addPlayer(world, "Depot Spread Test", "#ffffff");
	const villagers = Object.values(world.units)
		.filter((unit) => unit.ownerId === playerId && unit.type === "villager")
		.slice(0, 3);
	const townCenter = Object.values(world.buildings).find((building) => building.ownerId === playerId && building.type === "townCenter")!;
	const lumberCamp = createBuildingInstance("lumberCamp", {
		id: "b-test-lumber-camp",
		ownerId: playerId,
		x: townCenter.x + townCenter.width + 4,
		y: townCenter.y,
	});
	world.buildings[lumberCamp.id] = lumberCamp;
	const center = { x: lumberCamp.x, y: lumberCamp.y };
	world.resources = {};
	world._occupancy = new Uint8Array(MAP_SIZE * MAP_SIZE);
	markBuildingTiles(world, townCenter);
	markBuildingTiles(world, lumberCamp);
	const trees = [
		addTestResource(world, "spread-tree-a", center.x + 4, center.y),
		addTestResource(world, "spread-tree-b", center.x + 5, center.y),
		addTestResource(world, "spread-tree-c", center.x + 6, center.y),
	];

	const result = command(world, playerId, {
		type: "gather",
		playerId,
		unitIds: villagers.map((unit) => unit.id),
		targetId: lumberCamp.id,
	});

	assert.equal(result.ok, true);
	const assignedTargets = new Set(villagers.map((unit) => unit.command.type === "gather" ? unit.command.targetId : null));
	for (const tree of trees) assert.equal(assignedTargets.has(tree.id), true);
});

function findBuildPlacement(world: ReturnType<typeof createWorld>, originX: number, originY: number) {
	for (let radius = 2; radius <= 20; radius += 1) {
		for (let y = Math.floor(originY) - radius; y <= Math.floor(originY) + radius; y += 1) {
			for (let x = Math.floor(originX) - radius; x <= Math.floor(originX) + radius; x += 1) {
				if (x < 1 || y < 1 || x >= MAP_SIZE - 1 || y >= MAP_SIZE - 1) continue;
				if (world._occupancy?.[y * MAP_SIZE + x]) continue;
				if (Object.values(world.buildings).some((building) => building.x === x && building.y === y)) continue;
				return { x, y };
			}
		}
	}
	throw new Error("Could not find build placement.");
}

function findWallLinePlacement(world: ReturnType<typeof createWorld>, length: number) {
	for (let y = 1; y < MAP_SIZE - 1; y += 1) {
		for (let x = 1; x < MAP_SIZE - length - 1; x += 1) {
			const tiles = Array.from({ length }, (_, index) => ({ x: x + index, y }));
			if (tiles.every((tile) => !world._occupancy?.[tile.y * MAP_SIZE + tile.x]))
				return tiles;
		}
	}
	throw new Error("Could not find wall line placement.");
}

function addTestResource(world: ReturnType<typeof createWorld>, id: string, x: number, y: number) {
	const resource = {
		id,
		kind: "resource" as const,
		type: "tree" as const,
		resource: "wood" as const,
		x,
		y,
		amount: 100,
		maxAmount: 100,
	};
	world.resources[id] = resource;
	world._occupancy![y * MAP_SIZE + x] = 1;
	return resource;
}

function markBuildingTiles(world: ReturnType<typeof createWorld>, building: { x: number; y: number; width: number; height: number }) {
	for (let dy = 0; dy < building.height; dy += 1) {
		for (let dx = 0; dx < building.width; dx += 1) {
			const x = building.x + dx;
			const y = building.y + dy;
			if (x >= 0 && y >= 0 && x < MAP_SIZE && y < MAP_SIZE)
				world._occupancy![y * MAP_SIZE + x] = 1;
		}
	}
}
