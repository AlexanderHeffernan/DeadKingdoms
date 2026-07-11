import type { ResourceNodeType, ResourceType, Vec2 } from "../../shared/types.js";
import { ResourceCandidatePool } from "./ResourceCandidatePool.js";
import { ResourceDistributionPolicy } from "./ResourceDistributionPolicy.js";
import { ResourcePlacementGrid } from "./ResourcePlacementGrid.js";
import { SeededRng } from "./SeededRng.js";

export class ConnectedResourcePolicy extends ResourceDistributionPolicy {
	public constructor(
		resource: ResourceType,
		nodeType: ResourceNodeType,
		target: number,
		density: number,
		grid: ResourcePlacementGrid,
		candidates: ResourceCandidatePool,
		rng: SeededRng,
		clusterIdBase: number,
		private readonly minClusterSize: number,
		private readonly maxClusterSize: number,
	) {
		super(resource, nodeType, target, density, grid, candidates, rng, clusterIdBase);
	}

	protected createCluster(anchor: Vec2, remaining: number) {
		if (!this.grid.canPlace(anchor, 2)) return [];
		const desired = Math.min(remaining, this.rng.nextInt(this.minClusterSize, this.maxClusterSize));
		const placed: Vec2[] = [anchor];
		const staged = new Set([anchor.y * this.grid.size + anchor.x]);
		const frontier: Vec2[] = this.neighbors(anchor);
		let checks = 0;
		const checkLimit = Math.max(32, desired * 12);

		while (placed.length < desired && frontier.length > 0 && checks < checkLimit) {
			checks += 1;
			const index = this.rng.nextInt(0, frontier.length - 1);
			const point = frontier[index]!;
			frontier[index] = frontier[frontier.length - 1]!;
			frontier.pop();
			if (!this.canPlaceClusterPoint(point, staged)) continue;
			placed.push(point);
			staged.add(point.y * this.grid.size + point.x);
			frontier.push(...this.neighbors(point));
		}

		const required = Math.min(remaining, this.minClusterSize);
		return placed.length >= required ? placed : [];
	}

	private neighbors(point: Vec2) {
		return [
			{ x: point.x + 1, y: point.y },
			{ x: point.x - 1, y: point.y },
			{ x: point.x, y: point.y + 1 },
			{ x: point.x, y: point.y - 1 },
		];
	}
}
