import { SeededRng } from "./SeededRng.js";

export class ResourceCandidatePool {
	private cursor = 0;
	private readonly candidates: Uint32Array;

	public constructor(
		private readonly mapSize: number,
		indices: number[],
		rng: SeededRng,
	) {
		this.candidates = Uint32Array.from(indices);
		for (let index = this.candidates.length - 1; index > 0; index -= 1) {
			const swapIndex = rng.nextInt(0, index);
			const value = this.candidates[index]!;
			this.candidates[index] = this.candidates[swapIndex]!;
			this.candidates[swapIndex] = value;
		}
	}

	public get size() {
		return this.candidates.length;
	}

	public get exhausted() {
		return this.cursor >= this.candidates.length;
	}

	public take() {
		if (this.exhausted) return null;
		const index = this.candidates[this.cursor++]!;
		return { x: index % this.mapSize, y: Math.floor(index / this.mapSize) };
	}
}
