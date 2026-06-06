export type LogSink = (entry: PendingLogEntry) => void;

export type PendingLogEntry = {
	at: number;
	source: string;
	message: string;
};

export class Logs {
	private static source = "server";
	private static sink: LogSink | null = null;

	static setSource(source: string) {
		this.source = source;
	}

	static setSink(sink: LogSink | null) {
		this.sink = sink;
	}

	static log(message: string) {
		const text = message.trim();
		if (!text) return;
		const entry = {
			at: Date.now(),
			source: this.source,
			message: text,
		};
		if (this.sink) this.sink(entry);
			else console.log(`[${entry.source}] ${entry.message}`);
	}
}
