import type { Vec2 } from "../../shared/types.js";

export class ResourcePlacementGrid {
	private readonly clusterByTile: Int32Array;

	public constructor(public readonly size: number) {
		this.clusterByTile = new Int32Array(size * size);
	}

	public eligibleIndices() {
		const indices: number[] = [];
		for (let y = 1; y < this.size - 1; y += 1) {
			for (let x = 1; x < this.size - 1; x += 1)
				indices.push(y * this.size + x);
		}
		return indices;
	}

	public canPlace(point: Vec2, gap: number) {
		if (!this.inside(point)) return false;
		for (let dy = -gap; dy <= gap; dy += 1) {
			for (let dx = -gap; dx <= gap; dx += 1) {
				const x = point.x + dx;
				const y = point.y + dy;
				if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
				if (this.clusterByTile[y * this.size + x] !== 0) return false;
			}
		}
		return true;
	}

	public placeCluster(points: Vec2[], clusterId: number) {
		for (const point of points)
			this.clusterByTile[point.y * this.size + point.x] = clusterId;
	}

	private inside(point: Vec2) {
		return point.x >= 1 && point.y >= 1 && point.x < this.size - 1 && point.y < this.size - 1;
	}
}
