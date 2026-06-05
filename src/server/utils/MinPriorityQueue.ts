export class MinPriorityQueue<T> {
	private items: T[] = [];

	public constructor(private readonly score: (item: T) => number) {}

	public get length() {
		return this.items.length;
	}

	public push(item: T) {
		this.items.push(item);
		this.bubbleUp(this.items.length - 1);
	}

	public pop(): T | undefined {
		const first = this.items[0];
		const last = this.items.pop();
		if (this.items.length > 0 && last !== undefined) {
			this.items[0] = last;
			this.sinkDown(0);
		}
		return first;
	}

	private bubbleUp(index: number) {
		const item = this.items[index]!;
		const itemScore = this.score(item);

		while (index > 0) {
			const parentIndex = Math.floor((index - 1) / 2);
			const parent = this.items[parentIndex]!;
			if (itemScore >= this.score(parent)) break;
			this.items[index] = parent;
			index = parentIndex;
		}

		this.items[index] = item;
	}

	private sinkDown(index: number) {
		const item = this.items[index]!;
		const itemScore = this.score(item);
		const length = this.items.length;

		while (true) {
			const leftIndex = index * 2 + 1;
			const rightIndex = leftIndex + 1;
			let swapIndex = -1;
			let swapScore = itemScore;

			if (leftIndex < length) {
				const leftScore = this.score(this.items[leftIndex]!);
				if (leftScore < swapScore) {
					swapIndex = leftIndex;
					swapScore = leftScore;
				}
			}
			if (rightIndex < length) {
				const rightScore = this.score(this.items[rightIndex]!);
				if (rightScore < swapScore) {
					swapIndex = rightIndex;
				}
			}
			if (swapIndex === -1) break;

			this.items[index] = this.items[swapIndex]!;
			index = swapIndex;
		}

		this.items[index] = item;
	}
}
