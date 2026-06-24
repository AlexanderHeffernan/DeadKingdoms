import test from "node:test";
import assert from "node:assert/strict";
import { addPlayer, command, createWorld, stepWorld } from "./world.js";

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
