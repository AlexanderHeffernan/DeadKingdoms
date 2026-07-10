import type { ResourceNode, World } from "../shared/types.js";

export class DecayingResourceTracker {
	private static readonly trackers = new WeakMap<World, DecayingResourceTracker>();
	private readonly resources = new Map<ResourceNode["id"], ResourceNode>();

	public static for(world: World) {
		let tracker = this.trackers.get(world);
		if (!tracker) {
			tracker = new DecayingResourceTracker(world);
			this.trackers.set(world, tracker);
		}
		return tracker;
	}

	private constructor(private readonly world: World) {}

	public register(resource: ResourceNode) {
		if (resource.stage !== "stump") return;
		this.resources.set(resource.id, resource);
	}

	public unregister(resource: ResourceNode) {
		this.resources.delete(resource.id);
	}

	public step(
		dt: number,
		decaySeconds: number,
		remove: (resource: ResourceNode) => void,
	) {
		for (const [resourceId, resource] of this.resources) {
			if (
				this.world.resources[resourceId] !== resource ||
				resource.stage !== "stump"
			) {
				this.resources.delete(resourceId);
				continue;
			}
			resource.decay = (resource.decay || 0) + dt;
			if (resource.decay < decaySeconds) continue;
			this.resources.delete(resourceId);
			remove(resource);
		}
	}
}
