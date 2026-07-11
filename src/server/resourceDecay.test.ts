import assert from "node:assert/strict";
import test from "node:test";
import type { ResourceNode } from "../shared/types.js";
import { DecayingResourceTracker } from "./DecayingResourceTracker.js";
import { createWorld } from "./world.js";

class ResourceDecayTestWorld {
	public readonly world = createWorld(
		{ resourceDensity: { wood: 0, food: 0, ore: 0 } },
		{ mapSeed: "resource-decay-test" },
	);

	public addStump(id: string) {
		const resource: ResourceNode = {
			id,
			kind: "resource",
			type: "stump",
			resource: "wood",
			x: 10,
			y: 10,
			amount: 0,
			maxAmount: 100,
			stage: "stump",
			decay: 0,
		};
		this.world.resources[id] = resource;
		return resource;
	}
}

test("decaying resource tracker advances only registered stumps", () => {
	const fixture = new ResourceDecayTestWorld();
	const tracked = fixture.addStump("tracked");
	const untracked = fixture.addStump("untracked");
	const tracker = DecayingResourceTracker.for(fixture.world);
	tracker.register(tracked);

	tracker.step(0.5, 1, () => assert.fail("stump decayed too early"));
	assert.equal(tracked.decay, 0.5);
	assert.equal(untracked.decay, 0);

	tracker.step(0.5, 1, (resource) => {
		delete fixture.world.resources[resource.id];
	});
	assert.equal(fixture.world.resources[tracked.id], undefined);
	assert.equal(fixture.world.resources[untracked.id], untracked);
});

test("decaying resource tracker forgets resources removed elsewhere", () => {
	const fixture = new ResourceDecayTestWorld();
	const tracked = fixture.addStump("removed");
	const tracker = DecayingResourceTracker.for(fixture.world);
	tracker.register(tracked);
	delete fixture.world.resources[tracked.id];

	tracker.step(1, 1, () => assert.fail("stale stump should not be removed twice"));
	assert.equal(tracked.decay, 0);
});
