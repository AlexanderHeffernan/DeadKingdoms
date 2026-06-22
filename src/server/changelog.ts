import { promises as fs } from "node:fs";

export type ChangelogEntry = {
	sha: string;
	message: string;
	url: string;
	date: string | null;
};

export type Changelog = {
	generatedAt: string | null;
	repository: string;
	entries: ChangelogEntry[];
};

type GitHubCommit = {
	sha?: unknown;
	html_url?: unknown;
	commit?: {
		message?: unknown;
		committer?: { date?: unknown };
		author?: { date?: unknown };
	};
};

const DEFAULT_REPOSITORY = "AlexanderHeffernan/DeadKingdoms";
const DEFAULT_COMMIT_LIMIT = 8;

export class ChangelogStore {
	private changelog: Changelog;

	constructor(
		private readonly fallbackPath: URL,
		private readonly repository = process.env.CHANGELOG_REPOSITORY || DEFAULT_REPOSITORY,
		private readonly commitLimit = DEFAULT_COMMIT_LIMIT,
	) {
		this.changelog = {
			generatedAt: null,
			repository: this.repository,
			entries: [],
		};
	}

	async load() {
		await this.loadFallback();
		await this.fetchLatest().catch((error: unknown) => {
			console.warn(`Could not refresh changelog from GitHub: ${errorMessage(error)}`);
		});
	}

	current() {
		return this.changelog;
	}

	private async fetchLatest() {
		const response = await fetch(`https://api.github.com/repos/${this.repository}/commits?per_page=${this.commitLimit}`, {
			headers: {
				"Accept": "application/vnd.github+json",
				"User-Agent": "DeadKingdoms-server",
				...(process.env.GITHUB_TOKEN ? { "Authorization": `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
			},
		});
		if (!response.ok) throw new Error(`GitHub returned ${response.status}`);

		const commits = await response.json();
		if (!Array.isArray(commits)) throw new Error("GitHub returned an unexpected changelog payload");

		this.changelog = {
			generatedAt: new Date().toISOString(),
			repository: this.repository,
			entries: commits.map((commit) => this.entryFromCommit(commit as GitHubCommit)).filter((entry): entry is ChangelogEntry => !!entry),
		};
	}

	private entryFromCommit(commit: GitHubCommit): ChangelogEntry | null {
		const sha = String(commit.sha || "").slice(0, 12);
		const message = firstLine(commit.commit?.message);
		const url = String(commit.html_url || "");
		if (!sha || !message || !url) return null;
		return {
			sha,
			message,
			url,
			date: dateValue(commit.commit?.committer?.date) || dateValue(commit.commit?.author?.date),
		};
	}

	private async loadFallback() {
		try {
			const parsed = JSON.parse(await fs.readFile(this.fallbackPath, "utf8")) as Partial<Changelog>;
			this.changelog = {
				generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : null,
				repository: typeof parsed.repository === "string" ? parsed.repository : this.repository,
				entries: Array.isArray(parsed.entries) ? parsed.entries.filter(isChangelogEntry) : [],
			};
		} catch {
			// The checked-in changelog is only a fallback; startup fetch owns freshness.
		}
	}
}

function isChangelogEntry(value: unknown): value is ChangelogEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as ChangelogEntry;
	return typeof entry.sha === "string" && typeof entry.message === "string" && typeof entry.url === "string";
}

function firstLine(value: unknown) {
	const line = String(value || "Update").split(/\r?\n/).at(0);
	return (line || "Update").trim();
}

function dateValue(value: unknown) {
	return typeof value === "string" ? value : null;
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
