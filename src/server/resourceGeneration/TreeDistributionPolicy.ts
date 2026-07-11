import type { Vec2 } from "../../shared/types.js";
import { ResourceCandidatePool } from "./ResourceCandidatePool.js";
import { ResourceDistributionPolicy } from "./ResourceDistributionPolicy.js";
import { ResourcePlacementGrid } from "./ResourcePlacementGrid.js";
import { SeededRng } from "./SeededRng.js";

const FOREST_SHARE = 0.9;
const FOREST_MIN_RADIUS = 4;
const FOREST_RADIUS_VARIANCE = 12;

export class TreeDistributionPolicy extends ResourceDistributionPolicy {
	private readonly forestTarget: number;

	public constructor(
		target: number,
		density: number,
		grid: ResourcePlacementGrid,
		candidates: ResourceCandidatePool,
		fallbackCandidates: ResourceCandidatePool,
		rng: SeededRng,
		clusterIdBase: number,
	) {
		super("wood", "tree", target, density, grid, candidates, rng, clusterIdBase, fallbackCandidates);
		this.forestTarget = Math.round(target * FOREST_SHARE);
	}

	protected createCluster(anchor: Vec2, remaining: number) {
		if (!this.grid.canPlace(anchor, 2)) return [];
		if (this.candidatePass > 0 || this.achieved >= this.forestTarget) return [anchor];

		const radiusX = FOREST_MIN_RADIUS + this.rng.nextInt(0, FOREST_RADIUS_VARIANCE - 1);
		const radiusY = FOREST_MIN_RADIUS + this.rng.nextInt(0, FOREST_RADIUS_VARIANCE - 1);
		const wobble = this.rng.nextFloat() * Math.PI * 2;
		const pinch = this.rng.nextFloat() * Math.PI * 2;
		const limit = Math.min(remaining, this.forestTarget - this.achieved);
		const points: Vec2[] = [];
		const staged = new Set<number>();

		for (let dy = -radiusY; dy <= radiusY && points.length < limit; dy += 1) {
			for (let dx = -radiusX; dx <= radiusX && points.length < limit; dx += 1) {
				if (!this.insideForestShape(dx, dy, radiusX, radiusY, wobble, pinch)) continue;
				const point = { x: anchor.x + dx, y: anchor.y + dy };
				if (!this.canPlaceClusterPoint(point, staged)) continue;
				points.push(point);
				staged.add(point.y * this.grid.size + point.x);
			}
		}
		return points.length >= Math.min(remaining, 12) ? points : [];
	}

	private insideForestShape(dx: number, dy: number, radiusX: number, radiusY: number, wobble: number, pinch: number) {
		const angle = Math.atan2(dy, dx);
		const localRadiusX = radiusX * (0.85 + Math.sin(angle * 2 + pinch) * 0.18 + Math.cos(angle * 4 - wobble) * 0.12);
		const localRadiusY = radiusY * (0.85 + Math.cos(angle * 3 - pinch) * 0.16 + Math.sin(angle * 5 + wobble) * 0.1);
		const edge = 0.92 + Math.sin(angle * 3 + wobble) * 0.2 + Math.cos(angle * 7 - pinch) * 0.12;
		return (dx * dx) / (localRadiusX * localRadiusX) + (dy * dy) / (localRadiusY * localRadiusY) <= edge;
	}
}
