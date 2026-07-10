import assert from "node:assert/strict";
import test from "node:test";
import type { ResourceNode, ResourceType } from "../shared/types.js";
import { createWorld } from "./world.js";

const densityMap = (value: number) => ({ wood: value, food: value, ore: value });

class ResourceGenerationAssertions {
	public counts(resources: ResourceNode[]) {
		const counts: Record<ResourceType, number> = { wood: 0, food: 0, ore: 0 };
		for (const resource of resources) counts[resource.resource] += 1;
		return counts;
	}

	public signature(resources: ResourceNode[]) {
		return resources
			.map((resource) => `${resource.type}:${resource.x},${resource.y}`)
			.sort();
	}

	public validUniqueTiles(resources: ResourceNode[], mapSize: number) {
		const occupied = new Set<string>();
		for (const resource of resources) {
			assert.ok(resource.x >= 1 && resource.x < mapSize - 1);
			assert.ok(resource.y >= 1 && resource.y < mapSize - 1);
			const key = `${resource.x},${resource.y}`;
			assert.equal(occupied.has(key), false, `duplicate resource tile ${key}`);
			occupied.add(key);
		}
	}
}

const assertions = new ResourceGenerationAssertions();

test("seeded resource generation is deterministic", () => {
	const settings = { mapSize: 128, resourceDensity: densityMap(1) };
	const first = createWorld(settings, { mapSeed: "repeatable-map" });
	const second = createWorld(settings, { mapSeed: "repeatable-map" });
	assert.deepEqual(
		assertions.signature(Object.values(first.resources)),
		assertions.signature(Object.values(second.resources)),
	);
});

test("different map seeds produce different resource layouts", () => {
	const settings = { mapSize: 128, resourceDensity: densityMap(1) };
	const first = createWorld(settings, { mapSeed: "map-a" });
	const second = createWorld(settings, { mapSeed: "map-b" });
	assert.notDeepEqual(
		assertions.signature(Object.values(first.resources)),
		assertions.signature(Object.values(second.resources)),
	);
});

test("resource density scales exact node targets while space is available", () => {
	const half = assertions.counts(Object.values(createWorld(
		{ mapSize: 256, resourceDensity: densityMap(0.5) },
		{ mapSeed: "density" },
	).resources));
	const normal = assertions.counts(Object.values(createWorld(
		{ mapSize: 256, resourceDensity: densityMap(1) },
		{ mapSeed: "density" },
	).resources));
	const double = assertions.counts(Object.values(createWorld(
		{ mapSize: 256, resourceDensity: densityMap(2) },
		{ mapSeed: "density" },
	).resources));

	for (const resource of ["wood", "food", "ore"] as const) {
		assert.ok(Math.abs(half[resource] * 2 - normal[resource]) <= 1);
		assert.ok(double[resource] >= normal[resource] * 1.9);
		assert.ok(double[resource] <= normal[resource] * 2);
	}
});

test("zero density places no natural resources", () => {
	const world = createWorld(
		{ mapSize: 128, resourceDensity: densityMap(0) },
		{ mapSeed: "empty" },
	);
	assert.equal(Object.values(world.resources).length, 0);
});

test("high density remains bounded and produces legal unique tiles", () => {
	const world = createWorld(
		{ mapSize: 64, resourceDensity: densityMap(3) },
		{ mapSeed: "saturated" },
	);
	const resources = Object.values(world.resources);
	assert.ok(resources.length <= (world.map.size - 2) ** 2);
	assertions.validUniqueTiles(resources, world.map.size);
});
