import { getChangelog, getStatus, type ServerStatus } from "./api.js";
import type { ChangelogEntry } from "./api.js";
import { gameSettingsRegistry, type GameSettings } from "../../src/shared/gameSettings.js";
import { escapeHtml } from "./ui/dom.js";
import { GameSettingsForm } from "./ui/gameSettingsForm.js";
import villagerBaseUrl from "./sprites/villager_base.png";
import villagerFlagUrl from "./sprites/villager_flag.png";
import houseBaseUrl from "./sprites/house_base.png";
import houseFlagUrl from "./sprites/house_flag.png";
import townCenterBaseUrl from "./sprites/town_centre_base_v2.png";
import townCenterFlagUrl from "./sprites/town_centre_flag_v2.png";
import zombieBaseUrl from "./sprites/zombie_def.png";
import pillarBaseUrl from "./sprites/pillar_base.png";
import pillarFlagUrl from "./sprites/pillar_flag.png";
import soldierBaseUrl from "./sprites/soldier_base.png";
import soldierFlagUrl from "./sprites/soldier_flag.png";

const PLAYER_NAME_STORAGE_KEY = "rtsPlayerName";
const PLAYER_COLOR_STORAGE_KEY = "rtsPlayerColor";
const GITHUB_REPOSITORY_URL =
	"https://github.com/AlexanderHeffernan/DeadKingdoms";
const DEFAULT_PLAYER_COLORS = [
	"#ff2b1a",
	"#ff9f1c",
	"#ffe66d",
	"#2ec4b6",
	"#3a86ff",
	"#8338ec",
	"#ff4d8d",
	"#6cff5f",
];

type ContributorCredit = {
	name: string;
	avatarUrl: string;
	url: string;
	contribution: string;
};

type HowToPlayItem = {
	title: string;
	body: string;
	baseUrl: string;
	flagUrl?: string;
	flagColor?: string;
};

type JoinResult = {
	name: string;
	color: string;
	mode: "public" | "private";
	settings?: GameSettings;
};

const CONTRIBUTORS: ContributorCredit[] = [
	{
		name: "Alexander Heffernan",
		avatarUrl: "https://avatars.githubusercontent.com/u/78777604?v=4",
		url: "https://github.com/AlexanderHeffernan",
		contribution: "Creator, Full-Stack Engineer, Gameplay Designer.",
	},
	{
		name: "Oliver Heffernan",
		avatarUrl: "https://avatars.githubusercontent.com/u/90035248?s=130&v=4",
		url: "https://github.com/oliverheffernan",
		contribution: "Gameplay Programmer, Interface Artist, UI Designer.",
	},
	{
		name: "Cara Lill",
		avatarUrl:
			"https://avatars.githubusercontent.com/u/157843393?s=130&v=4",
		url: "https://github.com/Cara-Lill",
		contribution: "In-Game Sprite Artist.",
	},
];

const HOW_TO_PLAY_ITEMS: HowToPlayItem[] = [
	{
		title: "Grow fast.",
		body: "Villagers gather wood, food, and ore. Build depots near resources so carried supplies get dropped off sooner.",
		baseUrl: villagerBaseUrl,
		flagUrl: villagerFlagUrl,
	},
	{
		title: "Build smart.",
		body: "Houses raise population cap, farms make steady food, barracks train soldiers, archers, and scouts, and walls with towers help hold ground.",
		baseUrl: houseBaseUrl,
		flagUrl: houseFlagUrl,
	},
	{
		title: "Keep the Town Center alive.",
		body: "If it falls, your kingdom is dead and your units and buildings are wiped from the map.",
		baseUrl: townCenterBaseUrl,
		flagUrl: townCenterFlagUrl,
	},
	{
		title: "Sound matters.",
		body: "Chopping, mining, building, fighting, horns, and destroyed buildings can draw zombies toward your settlement.",
		baseUrl: zombieBaseUrl,
	},
	{
		title: "Night is dangerous.",
		body: "Vision drops after dusk, so walls, towers, scouts, and fallback plans matter more as the map gets dark.",
		baseUrl: pillarBaseUrl,
		flagUrl: pillarFlagUrl,
	},
	{
		title: "Watch your rivals.",
		body: "Other kingdoms can contest resources, raid exposed workers, and break defenses while the undead keep everyone under pressure.",
		baseUrl: soldierBaseUrl,
		flagUrl: soldierFlagUrl,
		flagColor: "#3a86ff",
	},
	{
		title: "Score is power.",
		body: "Completed buildings and living units decide your score. Global leaderboard entries are published after the map restarts.",
		baseUrl: soldierBaseUrl,
		flagUrl: soldierFlagUrl,
	},
];

export class HomeScreen {
	private readonly joinForm = document.getElementById(
		"joinForm",
	) as HTMLFormElement | null;
	private readonly nameInput = document.getElementById(
		"nameInput",
	) as HTMLInputElement | null;
	private readonly colorInput = document.getElementById(
		"colorInput",
	) as HTMLInputElement | null;
	private readonly joinButton = this.joinForm?.querySelector(
		"button[type='submit']",
	) as HTMLButtonElement | null;
	private readonly privateButton = document.getElementById(
		"privateGameButton",
	) as HTMLButtonElement | null;
	private readonly joinNotice = document.getElementById("joinNotice");
	private latestStatus: ServerStatus | null = null;
	private statusFull = false;
	private joining = false;
	private privateSettingsForm: GameSettingsForm | null = null;

	constructor(
		private readonly onJoinRequested: (result: JoinResult) => void,
		private readonly onBeforeJoin: () => void,
		private readonly showToast: (message: string) => void,
		private readonly privateRoomId: string | null = null,
	) {}

	wireDom() {
		if (this.nameInput) {
			this.nameInput.value =
				localStorage.getItem(PLAYER_NAME_STORAGE_KEY) || "";
			this.nameInput.addEventListener("input", () => this.showNotice(""));
			this.nameInput.focus();
			this.nameInput.select();
		}
		if (this.colorInput) {
			this.colorInput.value =
				localStorage.getItem(PLAYER_COLOR_STORAGE_KEY) ||
				this.randomDefaultPlayerColor();
			this.colorInput.addEventListener("input", () =>
				this.showNotice(""),
			);
			this.colorInput.addEventListener("keydown", (event) => {
				if (event.key !== "Enter") return;
				event.preventDefault();
				this.joinForm?.requestSubmit();
			});
		}
		this.joinForm?.addEventListener(
			"submit",
			(event) => void this.join(event),
		);
		if (this.privateButton) {
			if (this.privateRoomId) this.privateButton.textContent = "Join Private";
			this.privateButton.addEventListener("click", () => this.joinPrivate());
		}
		document
			.getElementById("howToPlayButton")
			?.addEventListener("click", () => this.openModal("howToPlayModal"));
		document
			.getElementById("howToPlayClose")
			?.addEventListener("click", () =>
				this.closeModal("howToPlayModal"),
			);
		document
			.getElementById("howToPlayModal")
			?.addEventListener("mousedown", (event) =>
				this.closeModalFromBackdrop(event),
			);
		document
			.getElementById("changelogButton")
			?.addEventListener("click", () => void this.openChangelog());
		document
			.getElementById("changelogClose")
			?.addEventListener("click", () =>
				this.closeModal("changelogModal"),
			);
		document
			.getElementById("changelogModal")
			?.addEventListener("mousedown", (event) =>
				this.closeModalFromBackdrop(event),
			);
	}

	renderStaticContent() {
		this.renderCredits();
		this.renderHowToPlayRows();
	}

	async updateStatus(options: { force?: boolean } = {}) {
		if (this.joinNotice?.textContent && !options.force) return;
		try {
			this.latestStatus = await getStatus();
			this.renderStatus();
		} catch {
			this.latestStatus = null;
			this.renderStatus();
		}
	}

	renderStatus() {
		const onlinePlayers = document.getElementById("onlinePlayers");
		const separator = document.getElementById("statusSeparator");
		const resetStatus = document.getElementById("resetStatus");
		const lastUpdateDate = document.getElementById("lastUpdateDate");
		const lastUpdateTime = document.getElementById("lastUpdateTime");
		const deadKingdomsCount = document.getElementById("deadKingdomsCount");
		if (
			!onlinePlayers &&
			!resetStatus &&
			!lastUpdateDate &&
			!lastUpdateTime &&
			!deadKingdomsCount
		)
			return;
		const status = this.latestStatus;
		if (!status) {
			this.setJoinButtonFull(false);
			if (onlinePlayers) onlinePlayers.textContent = "Players online: --";
			if (resetStatus) resetStatus.textContent = "--";
			if (lastUpdateDate) lastUpdateDate.textContent = "--";
			if (lastUpdateTime) lastUpdateTime.textContent = "--";
			if (deadKingdomsCount) deadKingdomsCount.textContent = "--";
			if (separator) separator.style.display = "none";
			return;
		}
		this.setJoinButtonFull(this.isServerFull(status));
		let count = 0;
		if (onlinePlayers) {
			onlinePlayers.textContent = this.onlinePlayersText(status);
			count += onlinePlayers.textContent ? 1 : 0;
		}
		if (resetStatus) {
			resetStatus.textContent = this.formatResetStatus(status);
			count += resetStatus.textContent ? 1 : 0;
		}
		if (separator) separator.style.display = count > 1 ? "inline" : "none";
		const updatedAt = status.lastUpdate
			? new Date(status.lastUpdate)
			: null;
		if (lastUpdateDate)
			lastUpdateDate.textContent = updatedAt
				? updatedAt.toLocaleDateString(undefined, {
						year: "numeric",
						month: "short",
						day: "numeric",
					})
				: "--";
		if (lastUpdateTime)
			lastUpdateTime.textContent = updatedAt
				? updatedAt.toLocaleTimeString(undefined, {
						hour: "numeric",
						minute: "2-digit",
						timeZoneName: "short",
					})
				: "--";
		if (deadKingdomsCount)
			deadKingdomsCount.textContent =
				status.deadKingdoms.toLocaleString();
	}

	showNotice(message: string) {
		if (!this.joinNotice) {
			if (message) this.showToast(message);
			return;
		}
		const onlinePlayers = document.getElementById("onlinePlayers");
		const separator = document.getElementById("statusSeparator");
		const resetStatus = document.getElementById("resetStatus");
		this.joinNotice.textContent = message;
		this.joinNotice.classList.toggle("hidden", !message);
		onlinePlayers?.classList.toggle("hidden", !!message);
		separator?.classList.toggle("hidden", !!message);
		resetStatus?.classList.toggle("hidden", !!message);
	}

	setJoining(joining: boolean) {
		this.joining = joining;
		if (this.joinButton) {
			this.joinButton.disabled = joining || this.statusFull;
			this.joinButton.textContent = joining ? "Joining..." : "Public Game";
		}
		if (this.privateButton) {
			this.privateButton.disabled = joining;
			this.privateButton.textContent = joining
				? "Joining..."
				: this.privateRoomId
					? "Join Private"
					: "Private Game";
		}
	}

	private join(event: SubmitEvent) {
		event.preventDefault();
		if (this.joining) return;
		if (this.statusFull) {
			this.showNotice("The world is full. Try again soon.");
			return;
		}
		this.requestJoin("public");
	}

	private joinPrivate() {
		if (this.joining) return;
		if (!this.privateRoomId) {
			this.openPrivateSettings();
			return;
		}
		this.requestJoin("private");
	}

	private requestJoin(mode: JoinResult["mode"], settings?: GameSettings) {
		this.setJoining(true);
		this.onBeforeJoin();
		this.showNotice("");
		const name = this.nameInput?.value.trim() ?? "";
		const color = this.colorInput?.value || "";
		this.showNotice("");
		localStorage.setItem(PLAYER_NAME_STORAGE_KEY, name);
		localStorage.setItem(PLAYER_COLOR_STORAGE_KEY, color);
		this.onJoinRequested({
			name,
			color,
			mode,
			settings,
		});
	}

	private openPrivateSettings() {
		const panel = this.ensurePrivateSettingsPanel();
		const container = panel.querySelector<HTMLElement>("[data-private-settings-form]");
		if (!container) return;
		this.privateSettingsForm = new GameSettingsForm(container);
		this.privateSettingsForm.render(gameSettingsRegistry.metadata("privateHost"), {
			title: "",
			values: gameSettingsRegistry.defaults(),
		});
		panel.classList.remove("hidden");
		panel.querySelectorAll("[data-private-settings-cancel]").forEach((button) => {
			if (button instanceof HTMLButtonElement)
				button.onclick = () => panel.classList.add("hidden");
		});
		const startButton = panel.querySelector("[data-private-settings-start]");
		if (startButton instanceof HTMLButtonElement) startButton.onclick = () => {
			const settings = gameSettingsRegistry.merge(
				gameSettingsRegistry.defaults(),
				this.privateSettingsForm?.valuePatch() ?? {},
			);
			panel.classList.add("hidden");
			this.requestJoin("private", settings);
		};
	}

	private ensurePrivateSettingsPanel() {
		let panel = document.getElementById("privateSettingsModal");
		if (panel) return panel;
		panel = document.createElement("section");
		panel.id = "privateSettingsModal";
		panel.className = "private-settings-modal hidden";
		panel.innerHTML = `
			<div class="private-settings-dialog">
				<header>
					<h2>Private Game</h2>
					<button type="button" data-private-settings-cancel="true" aria-label="Close private game settings">X</button>
				</header>
				<div class="private-settings-body" data-private-settings-form="true"></div>
				<div class="private-settings-actions">
					<button type="button" data-private-settings-cancel="true">Cancel</button>
					<button type="button" data-private-settings-start="true">Start Private Game</button>
				</div>
			</div>
		`;
		document.body.append(panel);
		return panel;
	}

	private renderCredits() {
		const credits = document.getElementById("homeCredits");
		if (!credits) return;
		credits.innerHTML = `
			<button id="changelogButton" class="github-link changelog-link" type="button">Change Log</button>
			<a class="github-link" href="${GITHUB_REPOSITORY_URL}" target="_blank" rel="noreferrer" aria-label="Open Dead Kingdoms on GitHub">
				<svg class="github-mark" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>
				<span>Open Source</span>
			</a>
			<div class="contributors" aria-label="Contributors">
				${CONTRIBUTORS.map(
					(contributor) => `
					<a class="contributor" href="${contributor.url}" target="_blank" rel="noreferrer" aria-label="${escapeHtml(contributor.name)}: ${escapeHtml(contributor.contribution)}">
						<img src="${contributor.avatarUrl}" alt="${escapeHtml(contributor.name)}" loading="lazy" />
						<span class="contributor-popup">
							<strong>${escapeHtml(contributor.name)}</strong>
							<span>${escapeHtml(contributor.contribution)}</span>
						</span>
					</a>
				`,
				).join("")}
			</div>
		`;
	}

	private renderHowToPlayRows() {
		const rows = document.getElementById("howToPlayRows");
		if (!rows) return;
		rows.innerHTML = HOW_TO_PLAY_ITEMS.map(
			(item) => `
			<p>
				<span class="how-to-sprite">
					<img class="how-to-sprite-base" src="${item.baseUrl}" alt="" />
					${item.flagUrl ? `<span class="how-to-sprite-flag" style="--flag-url: url('${item.flagUrl}'); --flag-color: ${item.flagColor || "#d8574f"}"></span>` : ""}
				</span>
				<span><strong>${escapeHtml(item.title)}</strong> ${escapeHtml(item.body)}</span>
			</p>
		`,
		).join("");
	}

	private async openChangelog() {
		const rows = document.getElementById("changelogRows");
		this.openModal("changelogModal");
		if (!rows) return;
		rows.innerHTML = `<div class="global-loading">Loading changes...</div>`;
		try {
			const changelog = await getChangelog();
			this.renderChangelogRows(changelog.entries || []);
		} catch {
			rows.innerHTML = `<div class="global-loading">Could not load recent changes.</div>`;
		}
	}

	private renderChangelogRows(entries: ChangelogEntry[]) {
		const rows = document.getElementById("changelogRows");
		if (!rows) return;
		if (!entries.length) {
			rows.innerHTML = `<div class="global-loading">No recent changes found.</div>`;
			return;
		}
		rows.innerHTML =
			entries
				.map(
					(entry) => `
			<a class="changelog-row" href="${escapeHtml(entry.url)}" target="_blank" rel="noreferrer">
				<span>${escapeHtml(this.shortCommitMessage(entry.message))}</span>
				<small>${escapeHtml(this.formatCommitDate(entry.date))}</small>
			</a>
		`,
				)
				.join("") +
			`
			<a class="changelog-all-link" href="${GITHUB_REPOSITORY_URL}/commits/main" target="_blank" rel="noreferrer">See all commits</a>
		`;
	}

	private openModal(id: string) {
		document.getElementById(id)?.classList.remove("hidden");
	}

	private closeModal(id: string) {
		document.getElementById(id)?.classList.add("hidden");
	}

	private closeModalFromBackdrop(event: MouseEvent) {
		if (
			event.target instanceof HTMLElement &&
			event.target === event.currentTarget
		)
			event.target.classList.add("hidden");
	}

	private randomDefaultPlayerColor() {
		return DEFAULT_PLAYER_COLORS[
			Math.floor(Math.random() * DEFAULT_PLAYER_COLORS.length)
		]!;
	}

	private shortCommitMessage(message: string) {
		return message.length > 72 ? `${message.slice(0, 69)}...` : message;
	}

	private formatCommitDate(value: string | null) {
		if (!value) return "recent";
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return "recent";
		return date.toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
		});
	}

	private onlinePlayersText(status: ServerStatus) {
		if (status.activePlayers == 0) return "";
		if (this.isServerFull(status)) return "World full";
		return `${status.activePlayers} players`;
	}

	private isServerFull(status: ServerStatus) {
		return status.activePlayers >= status.maxPlayers;
	}

	private setJoinButtonFull(full: boolean) {
		this.statusFull = full;
		if (!this.joinButton) return;
		this.joinButton.disabled = this.joining || full;
		this.joinButton.textContent = this.joining
			? "Joining..."
			: full
				? "World Full"
				: "Public Game";
	}

	private formatResetStatus(status: ServerStatus) {
		if (status.reset.state === "active") return "";
		if (status.reset.state === "cold") return "";
		const remainingMs = Math.max(0, status.reset.resetAt! - Date.now());
		if (remainingMs == 0) return "Map reset";
		return `Map resetting in ${this.formatDuration(remainingMs)}`;
	}

	private formatDuration(ms: number) {
		const totalSeconds = Math.ceil(ms / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		if (minutes <= 0) return `${seconds}s`;
		return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
	}
}
