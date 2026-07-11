export class SeededRng {
	private state: number;

	public constructor(private readonly seed: string) {
		this.state = this.hash(seed) || 0x6d2b79f5;
	}

	public nextFloat() {
		this.state = (this.state + 0x6d2b79f5) | 0;
		let value = this.state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	}

	public nextInt(min: number, max: number) {
		if (max < min) throw new Error("SeededRng received an empty integer range.");
		return min + Math.floor(this.nextFloat() * (max - min + 1));
	}

	public fork(label: string) {
		return new SeededRng(`${this.seed}:${label}`);
	}

	private hash(value: string) {
		let hash = 2166136261;
		for (let index = 0; index < value.length; index += 1) {
			hash ^= value.charCodeAt(index);
			hash = Math.imul(hash, 16777619);
		}
		return hash >>> 0;
	}
}
