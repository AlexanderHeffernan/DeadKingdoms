export type SpatialGridEntry<T> = {
	item: T;
	index: number;
	cellX: number;
	cellY: number;
};

export class SpatialGrid<T extends { x: number; y: number }> {
	public readonly entries: SpatialGridEntry<T>[] = [];
	private readonly buckets = new Map<string, SpatialGridEntry<T>[]>();

	public constructor(
		items: T[],
		private readonly cellSize: number,
	) {
		items.forEach((item, index) => this.add(item, index));
	}

	public nearby(point: { x: number; y: number }, radius: number): SpatialGridEntry<T>[] {
		const minCellX = Math.floor((point.x - radius) / this.cellSize);
		const maxCellX = Math.floor((point.x + radius) / this.cellSize);
		const minCellY = Math.floor((point.y - radius) / this.cellSize);
		const maxCellY = Math.floor((point.y + radius) / this.cellSize);
		const entries: SpatialGridEntry<T>[] = [];

		for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
			for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
				const bucket = this.buckets.get(this.key(cellX, cellY));
				if (bucket) entries.push(...bucket);
			}
		}

		return entries;
	}

	private add(item: T, index: number) {
		const cellX = Math.floor(item.x / this.cellSize);
		const cellY = Math.floor(item.y / this.cellSize);
		const entry = { item, index, cellX, cellY };
		this.entries.push(entry);
		const key = this.key(cellX, cellY);
		const bucket = this.buckets.get(key);
		if (bucket) bucket.push(entry);
			else this.buckets.set(key, [entry]);
	}

	private key(cellX: number, cellY: number): string {
		return `${cellX},${cellY}`;
	}
}
