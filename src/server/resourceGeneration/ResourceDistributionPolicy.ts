import type { ResourceNodeType, ResourceType, Vec2 } from "../../shared/types.js";
import { ResourceCandidatePool } from "./ResourceCandidatePool.js";
import { ResourcePlacementGrid } from "./ResourcePlacementGrid.js";
import { SeededRng } from "./SeededRng.js";
import type { PlannedResource, ResourceTypePlacementReport } from "./types.js";

export abstract class ResourceDistributionPolicy {
	protected achieved = 0;
	protected clusters = 0;
	protected candidateEvaluations = 0;
	protected candidatePass = 0;
	private nextClusterId: number;

	protected constructor(
		public readonly resource: ResourceType,
		protected readonly nodeType: ResourceNodeType,
		protected readonly target: number,
		protected readonly density: number,
		protected readonly grid: ResourcePlacementGrid,
		protected readonly candidates: ResourceCandidatePool,
		protected readonly rng: SeededRng,
		clusterIdBase: number,
		private readonly fallbackCandidates: ResourceCandidatePool | null = null,
	) {
		this.nextClusterId = clusterIdBase;
	}

	public get completionRatio() {
		return this.target === 0 ? 1 : this.achieved / this.target;
	}

	public get complete() {
		return this.achieved >= this.target || (
			this.candidates.exhausted && (!this.fallbackCandidates || this.fallbackCandidates.exhausted)
		);
	}

	public placeNext(): PlannedResource[] | null {
		if (this.complete) return null;
		while (!this.complete) {
			const anchor = this.takeCandidate();
			if (!anchor) break;
			this.candidateEvaluations += 1;
			const remaining = this.target - this.achieved;
			const points = this.createCluster(anchor, remaining);
			if (points.length === 0) continue;
			this.grid.placeCluster(points, this.nextClusterId++);
			this.achieved += points.length;
			this.clusters += 1;
			return points.map((point) => ({ ...point, type: this.nodeType }));
		}
		return null;
	}

	public report(): ResourceTypePlacementReport {
		return {
			resource: this.resource,
			density: this.density,
			eligible: this.candidates.size,
			target: this.target,
			achieved: this.achieved,
			clusters: this.clusters,
			candidateEvaluations: this.candidateEvaluations,
			saturated: this.achieved < this.target,
		};
	}

	protected abstract createCluster(anchor: Vec2, remaining: number): Vec2[];

	private takeCandidate() {
		const primary = this.candidates.take();
		if (primary) return primary;
		this.candidatePass = 1;
		return this.fallbackCandidates?.take() ?? null;
	}

	protected canPlaceClusterPoint(point: Vec2, staged: Set<number>, gap = 2) {
		const index = point.y * this.grid.size + point.x;
		return !staged.has(index) && this.grid.canPlace(point, gap);
	}
}
