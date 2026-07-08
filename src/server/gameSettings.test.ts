import assert from "node:assert/strict";
import test from "node:test";
import { PrivateGameSettings } from "../shared/gameSettings.js";
import { addPlayer, createWorld } from "./world.js";

test("private game settings set world map size and spawn players inside it", () => {
	const settings = new PrivateGameSettings({
		mapSize: 128,
		maxPlayers: 4,
		gameSpeed: 1,
		zombieSpawnRate: 1,
		resourceDensity: { wood: 1, food: 1, ore: 1 },
	});
	const world = createWorld(settings);
	const addResult = addPlayer(world, "Map Size Test", "#ffffff");
	assert.equal(addResult.ok, true);
	if (!addResult.ok) return;
	const playerId = addResult.playerId;
	const townCenter = Object.values(world.buildings).find(
		(building) => building.ownerId === playerId && building.type === "townCenter",
	);

	assert.equal(world.map.size, 128);
	assert.equal(world.settings?.mapSize, 128);
	assert.ok(townCenter);
	assert.ok(townCenter.x >= 0 && townCenter.x + townCenter.width <= world.map.size);
	assert.ok(townCenter.y >= 0 && townCenter.y + townCenter.height <= world.map.size);
});

test("addPlayer rejects players beyond configured max player count", () => {
	const settings = new PrivateGameSettings({
		mapSize: 128,
		maxPlayers: 1,
		gameSpeed: 1,
		zombieSpawnRate: 1,
		resourceDensity: { wood: 1, food: 1, ore: 1 },
	});
	const world = createWorld(settings);
	const first = addPlayer(world, "First", "#ffffff");
	const second = addPlayer(world, "Second", "#ffffff");

	assert.equal(first.ok, true);
	assert.deepEqual(second, { ok: false, error: "Server is full." });
	assert.equal(Object.values(world.players).length, 1);
});
