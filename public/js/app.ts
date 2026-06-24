import { banPlayer as requestBanPlayer, disableAdminMode as requestDisableAdminMode, emitNoise as requestEmitNoise, enableAdminAccess, enableFullMapVision as requestFullMapVision, enablePathDebug, enableSoundDebug as requestSoundDebug, enableZombieDebug as requestZombieDebug, getChangelog, getGlobalLeaderboard, getGlobalLeaderboardSnapshot, getStatus, ServerStatus, grantSoldiers as requestGrantSoldiers, join, kickPlayer as requestKickPlayer, leave, logClientMessage, reportPing, restartServer as requestRestartServer, sendCommand, setTimeOfDay as requestSetTimeOfDay, spawnZombieHorde, toggleTownCenterInvincible as requestTownCenterInvincible, unbanIp as requestUnbanIp } from "./api.js";
import { Renderer } from "./render.js";
import { screenToIso, isoToScreen } from "./iso.js";
import { SoundEffects, buildingCommandSound, commandSoundForTarget } from "./sfx.js";
import { UI } from "./ui.js";
import { BUILDINGS, SCALE, TILE_H, TRAINING } from "./constants.js";
import { BUILDING_TYPES, deserializeBuilding } from "../../src/shared/buildings/index.js";
import { allUnitClasses, unitBehaviorFor } from "../../src/shared/unitRegistry.js";
import { spriteMetrics } from "./sprites/spriteInfo.js";
import { Logs } from "../../src/shared/logs.js";
import { DAY_NIGHT_CYCLE_SECONDS, dayNightStateAt } from "../../src/shared/dayNight.js";
import { escapeHtml } from "./ui/dom.js";
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
import type { Building, BuildingType, CommandPayload, Corpse, EntityId, GlobalLeaderboardEntry, LeaderboardPreviewSnapshot, PlayerId, ResourceNode, ResourceType, Ruin, Snapshot, SnapshotDelta, SnapshotMessage, Unit, UnitType } from "../../src/shared/types.js";
import type { ChangelogEntry } from "./api.js";
import type { ClientCommand, ClientSnapshot, GameState, ViewState } from "./clientTypes.js";

const state: GameState = {
	playerId: localStorage.getItem("rtsPlayerId") || null,
	snapshot: null,
	selectedIds: new Set(),
	lastSeen: { buildings: {}, resources: {}, ruins: {} },
	effects: [],
	idleWorkerCycleIndex: -1,
	// Persistent fog-of-war memory. Server sends only newly-discovered tile keys
	// each tick as `visibility.exploredDelta`; the client accumulates them.
	exploredSet: new Set(),
	timeOffsetSeconds: 0,
};

Logs.setSource("client");
Logs.setSink((entry) => {
	void logClientMessage(state.playerId, entry.message);
});

const music: {
	audio: HTMLAudioElement;
	tracks: string[];
	muted: boolean;
	started: boolean;
} = {
		audio: new Audio(),
		tracks: [],
		muted: localStorage.getItem("rtsMusicMuted") === "true",
		started: false,
	};

const view: ViewState = {
	camera: { x: window.innerWidth / 2, y: 90, zoom: 1 },
	dragging: false,
	panning: false,
	dragStart: null,
	dragCurrent: null,
	panLast: null,
	selectedIds: state.selectedIds,
	buildMode: null,
	rallyModeBuildingId: null,
	noiseMode: false,
	instantBuildMode: false,
	hoverTile: null,
	mouse: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
	wallDragStartTile: null,
};
const sfx = new SoundEffects(view.camera);

const ZOOM_STEPS = [0.2, 0.3, 0.4, 0.55, 0.75, 1, 1.25, 1.5, 1.75, 2];
const EDGE_PAN_MARGIN = 14;
const DEV_COMMAND_BUFFER_LENGTH = 40;
const PLAYER_NAME_STORAGE_KEY = "rtsPlayerName";
const PLAYER_COLOR_STORAGE_KEY = "rtsPlayerColor";
const TEXT_SCALE_STORAGE_KEY = "rtsTextScale";
const DEFAULT_TEXT_SCALE = 100;
const MIN_TEXT_SCALE = 80;
const MAX_TEXT_SCALE = 150;
const TEXT_SCALE_SLIDER_THUMB_WIDTH = 14;
const GITHUB_REPOSITORY_URL = "https://github.com/AlexanderHeffernan/DeadKingdoms";
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
		avatarUrl: "https://avatars.githubusercontent.com/u/157843393?s=130&v=4",
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
		title: "Score is power.",
		body: "Completed buildings and living units decide your score. Global leaderboard entries are published after the map restarts.",
		baseUrl: soldierBaseUrl,
		flagUrl: soldierFlagUrl,
	},
];

interface ContributorCredit {
	name: string;
	avatarUrl: string;
	url: string;
	contribution: string;
}

interface HowToPlayItem {
	title: string;
	body: string;
	baseUrl: string;
	flagUrl?: string;
}

const canvas = document.getElementById("world") as HTMLCanvasElement | null;
const minimap = document.getElementById("minimap") as HTMLCanvasElement | null;
if (!canvas || !minimap) throw new Error("Missing canvas elements");
const renderer = new Renderer(canvas, { minimap, sizeMode: "viewport" });
const snapshotPreviewCanvas = document.getElementById("snapshotPreviewCanvas") as HTMLCanvasElement | null;
const snapshotPreviewRenderer = snapshotPreviewCanvas ? new Renderer(snapshotPreviewCanvas) : null;
let eventStream: EventSource | null = null;
let devCommandInput = "";
let adminAccessEnabled = false;
let godModeCheckPending = false;
let pathDebugEnabled = false;
let pathDebugCheckPending = false;
let zombieHordePending = false;
let lastFrameAt = performance.now();
let smoothedFps = 60;
let lastPingReportAt = 0;
let adminDiagnosticsVisible = false;
let adminView: "closed" | "popup" | "overview" | "performance" | "players" | "logs" | "devCommands" | "bans" = "closed";
let latestHomeStatus: ServerStatus | null = null;
let lastSnapshotSeq = 0;

const joinForm = document.getElementById("joinForm") as HTMLFormElement | null;
const nameInput = document.getElementById("nameInput") as HTMLInputElement | null;
const colorInput = document.getElementById("colorInput") as HTMLInputElement | null;
const joinButton = joinForm?.querySelector("button[type='submit']") as HTMLButtonElement | null;
const joinNotice = document.getElementById("joinNotice");
let homeStatusFull = false;

if (nameInput) {
	nameInput.value = localStorage.getItem(PLAYER_NAME_STORAGE_KEY) || "";
	nameInput.addEventListener("input", () => showJoinNotice(""));
	nameInput.focus();
	nameInput.select();
}
if (colorInput) {
	colorInput.value = localStorage.getItem(PLAYER_COLOR_STORAGE_KEY) || randomDefaultPlayerColor();
	colorInput.addEventListener("input", () => showJoinNotice(""));
	colorInput.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		joinForm?.requestSubmit();
	});
}
renderHomeCredits();
wireHomeModals();
const ui = new UI(state, {
	setBuildMode(type) {
		view.buildMode = type;
	},
	selectIdleWorkers: () => selectIdleWorkers(),
		train(buildingId: string, unitType: UnitType) {
			issue({ type: "train", buildingId, unitType }).then((result) => {
				if (result.ok) sfx.play("train_queue", { point: state.snapshot?.buildings[buildingId] });
				else sfx.play(errorMessage(result).includes("Population") ? "population_blocked" : "ui_error");
			});
		},
	blowHorn(unitIds) {
		issue({ type: "blowHorn", unitIds }).then((result) => {
			if (!result.ok) sfx.play("ui_error");
		});
	},
	toggleAutoFarm() {
		issue({ type: "toggleAutoFarm" }).then((result) => sfx.play(result.ok ? "toast_notice" : "ui_error"));
	},
	replenishFarm(farmId) {
		issue({ type: "replenishFarm", farmId }).then((result) => {
			sfx.play(result.ok ? "farm_replenish" : "ui_error", { point: state.snapshot?.buildings[farmId] });
		});
	},
	deleteBuilding(buildingId) {
		issue({ type: "deleteBuilding", buildingId }).then((result) => sfx.play(result.ok ? "building_destroyed" : "ui_error"));
	},
	setRallyMode(buildingId) {
		view.rallyModeBuildingId = buildingId;
		ui.showToast("Choose a rally point.");
		sfx.play("ui_command_move", { point: state.snapshot?.buildings[buildingId] });
	},
	async respawn() {
		if (!state.playerId) return;
		await leave(state.playerId);
		localStorage.removeItem("rtsPlayerId");
		window.location.reload();
	},
	async disableAdminMode() {
		if (!state.playerId) return "No active player.";
		const result = await requestDisableAdminMode(state.playerId);
		if (!result.ok) return result.error || "Could not disable admin mode.";
		state.exploredSet.clear();
		view.noiseMode = false;
		adminDiagnosticsVisible = false;
		connectEvents();
		ui.showToast("Admin mode disabled.");
		ui.render();
		return "Admin mode disabled.";
	},
	async enableFullMapVision() {
		if (!state.playerId) return "No active player.";
		const result = await requestFullMapVision(state.playerId);
		if (!result.ok) return result.error || "Could not enable full-map admin vision.";
		state.exploredSet.clear();
		connectEvents();
		const message = result.enabled ? "Full-map admin vision enabled." : "Full-map admin vision disabled.";
		ui.showToast(message);
		return message;
	},
	async enableSoundDebug() {
		if (!state.playerId) return "No active player.";
		const result = await requestSoundDebug(state.playerId);
		if (!result.ok) return result.error || "Could not enable sound field overlay.";
		connectEvents();
		const message = result.enabled ? "Sound field overlay enabled." : "Sound field overlay disabled.";
		ui.showToast(message);
		return message;
	},
	async setTimeOfDay(progress, label) {
		if (!state.playerId) return "No active player.";
		const currentProgress = state.snapshot?.dayNight.cycleProgress ?? 0;
		state.timeOffsetSeconds += (progress - currentProgress) * DAY_NIGHT_CYCLE_SECONDS;
		if (state.snapshot) state.snapshot.dayNight = offsetDayNight(state.snapshot.dayNight, state.timeOffsetSeconds);
		let message = `Set time to ${label}.`;
		try {
			const result = await requestSetTimeOfDay(state.playerId, progress);
			if (result.ok) state.timeOffsetSeconds = 0;
			else message = `${message} (client preview only: ${result.error || "server rejected it"})`;
		} catch {
			message = `${message} (client preview only: server unavailable)`;
		}
		ui.showToast(message);
		ui.render();
		return message;
	},
	async enableZombieDebug() {
		if (!state.playerId) return "No active player.";
		const result = await requestZombieDebug(state.playerId);
		if (!result.ok) return result.error || "Could not enable zombie state overlay.";
		connectEvents();
		const message = result.enabled ? "Zombie state overlay enabled." : "Zombie state overlay disabled.";
		ui.showToast(message);
		return message;
	},
	async kickPlayer(targetPlayerId) {
		if (!state.playerId) return "No active player.";
		const result = await requestKickPlayer(state.playerId, targetPlayerId);
		if (!result.ok) return result.error || "Could not kick player.";
		return "Player kicked.";
	},
	async banPlayer(targetPlayerId) {
		if (!state.playerId) return "No active player.";
		const result = await requestBanPlayer(state.playerId, targetPlayerId);
		if (!result.ok) return result.error || "Could not ban player.";
		return `Banned ${result.ipAddress ?? "player IP"}.`;
	},
	async unbanIp(ipAddress) {
		if (!state.playerId) return "No active player.";
		const result = await requestUnbanIp(state.playerId, ipAddress);
		if (!result.ok) return result.error || "Could not unban IP.";
		return "IP unbanned.";
	},
	async spawnHostileHorde() {
		if (!state.playerId) return "No active player.";
		const result = await spawnZombieHorde(state.playerId, 500);
		if (!result.ok) return result.error || "Could not spawn hostile horde.";
		ui.showToast(`Spawned ${result.spawned ?? 500} hostile units.`);
		return `Spawned ${result.spawned ?? 500} hostile units.`;
	},
	async grantSoldiers() {
		if (!state.playerId) return "No active player.";
		const result = await requestGrantSoldiers(state.playerId, 100);
		if (!result.ok) return result.error || "Could not grant soldiers.";
		ui.showToast(`Granted ${result.granted ?? 100} soldiers.`);
		return `Granted ${result.granted ?? 100} soldiers.`;
	},
	async toggleTownCenterInvincible() {
		if (!state.playerId) return "No active player.";
		const result = await requestTownCenterInvincible(state.playerId);
		if (!result.ok) return result.error || "Could not toggle town center invincibility.";
		const message = result.invincible ? "Town center is now invincible." : "Town center invincibility disabled.";
		ui.showToast(message);
		return message;
	},
	async toggleNoiseTool() {
		view.noiseMode = !view.noiseMode;
		const message = view.noiseMode
			? "Noise tool ON — left-click the map to make a bang. Esc or right-click to stop."
			: "Noise tool off.";
		ui.showToast(message);
		return message;
	},
	async toggleInstantBuild() {
		view.instantBuildMode = !view.instantBuildMode;
		const message = view.instantBuildMode
			? "Instant build ON. Use building hotkeys, then click the map to place completed buildings."
			: "Instant build off.";
		ui.showToast(message);
		return message;
	},
	async restartServer() {
		if (!state.playerId) return "No active player.";
		const result = await requestRestartServer(state.playerId);
		if (!result.ok) return result.error || "Could not restart server.";
		resetToJoin("Server restarted. Join again to start a fresh map.");
		return "Server restarted.";
	},
});

joinForm?.addEventListener("submit", async (event) => {
	event.preventDefault();
	if (homeStatusFull) {
		showJoinNotice("The world is full. Try again soon.");
		return;
	}
	sfx.unlock();
	showJoinNotice("");
	const name = nameInput?.value.trim() || "Player";
	const color = colorInput?.value || "";
	const result = await join(name, color);
	if (!result.ok) {
		showJoinNotice(result.error || "Could not join.");
		return;
	}
	showJoinNotice("");
	state.playerId = result.playerId;
	localStorage.setItem(PLAYER_NAME_STORAGE_KEY, name);
	localStorage.setItem(PLAYER_COLOR_STORAGE_KEY, color);
	localStorage.setItem("rtsPlayerId", result.playerId);
	enterGame();
});

document.getElementById("leaveButton")?.addEventListener("click", async () => {
	sfx.unlock();
	await leaveCurrentGame("You left the game.");
	void updateHomeStatus({ force: true });
});
document.getElementById("settingsButton")?.addEventListener("click", openSettingsModal);
document.getElementById("settingsCloseButton")?.addEventListener("click", closeSettingsModal);
document.getElementById("settingsMuteButton")?.addEventListener("click", toggleMusicMute);
document.getElementById("settingsModal")?.addEventListener("pointerdown", closeSettingsModalOnBackdrop);
document.getElementById("textScaleInput")?.addEventListener("input", (event) => {
	if (!(event.target instanceof HTMLInputElement)) return;
	setTextScale(Number(event.target.value));
});
document.addEventListener("keydown", closeSettingsModalOnEscape);
window.addEventListener("resize", () => updateTextScaleControl(storedTextScale()));
document.getElementById("leaderboardToggle")?.addEventListener("click", () => {
	const container = document.getElementById("leaderboardPanel");
	const toggle = document.getElementById("leaderboardToggle");
	if (!container || !toggle) return;
	const collapsed = !container.classList.contains("collapsed");
	container.classList.toggle("collapsed", collapsed);
	toggle.setAttribute("aria-expanded", String(!collapsed));
	toggle.setAttribute("aria-label", collapsed ? "Show leaderboard" : "Hide leaderboard");
	toggle.title = collapsed ? "Show leaderboard" : "Hide leaderboard";
});
window.addEventListener("admin-subscription", (event) => {
	const viewName = event instanceof CustomEvent && typeof event.detail?.view === "string" ? event.detail.view : "popup";
	if (!isAdminView(viewName) || adminView === viewName) return;
	adminView = viewName;
	if (state.playerId && adminAccessEnabled) connectEvents();
});

window.addEventListener("resize", () => renderer.resize());
window.addEventListener("mousemove", trackMousePosition);
window.addEventListener("beforeunload", () => {
	if (state.playerId) leave(state.playerId);
});

canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener("selectstart", (event) => event.preventDefault());
canvas.addEventListener("dragstart", (event) => event.preventDefault());
canvas.addEventListener("mousedown", onMouseDown);
canvas.addEventListener("mousemove", onMouseMove);
canvas.addEventListener("mouseup", onMouseUp);
canvas.addEventListener("wheel", (event) => {
	event.preventDefault();
	const before = screenToIso(event.clientX, event.clientY, view.camera);
	view.camera.zoom = nextZoom(view.camera.zoom!, event.deltaY < 0 ? 1 : -1);
	const after = isoToScreen(before.x, before.y, view.camera);
	view.camera.x += event.clientX - after.x;
	view.camera.y += event.clientY - after.y;
	clampCamera();
});
window.addEventListener("keydown", onKeyDown);
window.addEventListener("keydown", onDevShortcutKeyDown);
minimap.addEventListener("mousedown", (event) => moveCameraFromMinimap(event));
minimap.addEventListener("mousemove", (event) => {
	if (event.buttons === 1) moveCameraFromMinimap(event);
});
minimap.addEventListener("contextmenu", (event) => event.preventDefault());
minimap.addEventListener("mousedown", onMinimapMouseDown);

renderer.resize();
initTextScaleSetting();
drawLoop();
initMusic();
updateHomeStatus();
setInterval(updateHomeStatus, 2000);
setInterval(renderHomeStatus, 1000);
if (state.playerId) enterGame();

function enterGame() {
	document.getElementById("join")!.classList.add("hidden");
	document.getElementById("game")?.classList.remove("hidden");
	renderer.resize();
	startMusic();
	connectEvents();
}

function randomDefaultPlayerColor() {
	return DEFAULT_PLAYER_COLORS[Math.floor(Math.random() * DEFAULT_PLAYER_COLORS.length)]!;
}

function showJoinNotice(message: string) {
	if (!joinNotice) {
		if (message) ui.showToast(message);
		return;
	}
	const onlinePlayers = document.getElementById("onlinePlayers");
	const separator = document.getElementById("statusSeparator");
	const resetStatus = document.getElementById("resetStatus");
	joinNotice.textContent = message;
	joinNotice.classList.toggle("hidden", !message);
	onlinePlayers?.classList.toggle("hidden", !!message);
	separator?.classList.toggle("hidden", !!message);
	resetStatus?.classList.toggle("hidden", !!message);
}

function renderHomeCredits() {
	const credits = document.getElementById("homeCredits");
	if (!credits) return;
	credits.innerHTML = `
		<button id="changelogButton" class="github-link changelog-link" type="button">Change Log</button>
		<a class="github-link" href="${GITHUB_REPOSITORY_URL}" target="_blank" rel="noreferrer" aria-label="Open Dead Kingdoms on GitHub">
			<svg class="github-mark" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>
			<span>Open Source</span>
		</a>
		<div class="contributors" aria-label="Contributors">
			${CONTRIBUTORS.map((contributor) => `
				<a class="contributor" href="${contributor.url}" target="_blank" rel="noreferrer" aria-label="${escapeHtml(contributor.name)}: ${escapeHtml(contributor.contribution)}">
					<img src="${contributor.avatarUrl}" alt="${escapeHtml(contributor.name)}" loading="lazy" />
					<span class="contributor-popup">
						<strong>${escapeHtml(contributor.name)}</strong>
						<span>${escapeHtml(contributor.contribution)}</span>
					</span>
				</a>
			`).join("")}
		</div>
	`;
}

const previewState: GameState = {
	playerId: null,
	snapshot: null,
	selectedIds: new Set(),
	lastSeen: { buildings: {}, resources: {}, ruins: {} },
	effects: [],
	idleWorkerCycleIndex: -1,
	exploredSet: new Set(),
	timeOffsetSeconds: 0,
};
const previewView: ViewState = {
	camera: { x: 0, y: 0, zoom: 0.55 },
	dragging: false,
	panning: false,
	dragStart: null,
	dragCurrent: null,
	panLast: null,
	selectedIds: previewState.selectedIds,
	buildMode: null,
	rallyModeBuildingId: null,
	noiseMode: false,
	instantBuildMode: false,
	hoverTile: null,
	wallDragStartTile: null,
	mouse: { x: 0, y: 0 },
};
let previewAnimation = 0;

function wireHomeModals() {
	renderHowToPlayRows();
	document.getElementById("homeLeaderboardButton")?.addEventListener("click", () => void openGlobalLeaderboard());
	document.getElementById("globalLeaderboardClose")?.addEventListener("click", closeGlobalLeaderboard);
	document.getElementById("globalLeaderboardModal")?.addEventListener("mousedown", (event) => {
		if (event.target === event.currentTarget) closeGlobalLeaderboard();
	});
	document.getElementById("howToPlayButton")?.addEventListener("click", () => openModal("howToPlayModal"));
	document.getElementById("howToPlayClose")?.addEventListener("click", () => closeModal("howToPlayModal"));
	document.getElementById("howToPlayModal")?.addEventListener("mousedown", closeModalFromBackdrop);
	document.getElementById("changelogButton")?.addEventListener("click", () => void openChangelog());
	document.getElementById("changelogClose")?.addEventListener("click", () => closeModal("changelogModal"));
	document.getElementById("changelogModal")?.addEventListener("mousedown", closeModalFromBackdrop);
	document.getElementById("snapshotPreviewClose")?.addEventListener("click", closeSnapshotPreview);
	document.getElementById("snapshotPreviewModal")?.addEventListener("mousedown", (event) => {
		if (event.target === event.currentTarget) closeSnapshotPreview();
	});
	if (!snapshotPreviewCanvas) return;
	snapshotPreviewCanvas.addEventListener("contextmenu", (event) => event.preventDefault());
	snapshotPreviewCanvas.addEventListener("mousedown", beginPreviewClick);
	snapshotPreviewCanvas.addEventListener("mousemove", movePreviewMouse);
	snapshotPreviewCanvas.addEventListener("mouseup", endPreviewClick);
	snapshotPreviewCanvas.addEventListener("mouseleave", () => {
		previewView.dragging = false;
		previewView.mouse = { x: -Infinity, y: -Infinity };
	});
	snapshotPreviewCanvas.addEventListener("wheel", zoomPreview, { passive: false });
}

function renderHowToPlayRows() {
	const rows = document.getElementById("howToPlayRows");
	if (!rows) return;
	rows.innerHTML = HOW_TO_PLAY_ITEMS.map((item) => `
		<p>
			<span class="how-to-sprite">
				<img class="how-to-sprite-base" src="${item.baseUrl}" alt="" />
				${item.flagUrl ? `<span class="how-to-sprite-flag" style="--flag-url: url('${item.flagUrl}')"></span>` : ""}
			</span>
			<span><strong>${escapeHtml(item.title)}</strong> ${escapeHtml(item.body)}</span>
		</p>
	`).join("");
}

function openModal(id: string) {
	document.getElementById(id)?.classList.remove("hidden");
}

function closeModal(id: string) {
	document.getElementById(id)?.classList.add("hidden");
}

function closeModalFromBackdrop(event: MouseEvent) {
	if (event.target instanceof HTMLElement && event.target === event.currentTarget) {
		event.target.classList.add("hidden");
	}
}

async function openGlobalLeaderboard() {
	const modal = document.getElementById("globalLeaderboardModal");
	const rows = document.getElementById("globalLeaderboardRows");
	if (!modal || !rows) return;
	modal.classList.remove("hidden");
	rows.innerHTML = `<div class="global-loading">Loading scores...</div>`;
	try {
		const result = await getGlobalLeaderboard();
		renderGlobalLeaderboardRows(result.entries || []);
	} catch {
		rows.innerHTML = `<div class="global-loading">Could not load the leaderboard.</div>`;
	}
}

function closeGlobalLeaderboard() {
	document.getElementById("globalLeaderboardModal")?.classList.add("hidden");
}

async function openChangelog() {
	const rows = document.getElementById("changelogRows");
	openModal("changelogModal");
	if (!rows) return;
	rows.innerHTML = `<div class="global-loading">Loading changes...</div>`;
	try {
		const changelog = await getChangelog();
		renderChangelogRows(changelog.entries || []);
	} catch {
		rows.innerHTML = `<div class="global-loading">Could not load recent changes.</div>`;
	}
}

function renderChangelogRows(entries: ChangelogEntry[]) {
	const rows = document.getElementById("changelogRows");
	if (!rows) return;
	if (!entries.length) {
		rows.innerHTML = `<div class="global-loading">No recent changes found.</div>`;
		return;
	}
	rows.innerHTML = entries.map((entry) => `
		<a class="changelog-row" href="${escapeHtml(entry.url)}" target="_blank" rel="noreferrer">
			<span>${escapeHtml(shortCommitMessage(entry.message))}</span>
			<small>${escapeHtml(formatCommitDate(entry.date))}</small>
		</a>
	`).join("") + `
		<a class="changelog-all-link" href="${GITHUB_REPOSITORY_URL}/commits/main" target="_blank" rel="noreferrer">See all commits</a>
	`;
}

function shortCommitMessage(message: string) {
	return message.length > 72 ? `${message.slice(0, 69)}...` : message;
}

function formatCommitDate(value: string | null) {
	if (!value) return "recent";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "recent";
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderGlobalLeaderboardRows(entries: GlobalLeaderboardEntry[]) {
	const rows = document.getElementById("globalLeaderboardRows");
	if (!rows) return;
	if (!entries.length) {
		rows.innerHTML = `<div class="global-loading">No scores recorded yet.</div>`;
		return;
	}
	rows.innerHTML = entries.map((entry, index) => `
		<div class="global-leaderboard-row">
			<span class="global-rank">#${index + 1}</span>
			<strong style="color: ${escapeHtml(entry.playerColor)}">${escapeHtml(entry.playerName)}</strong>
			<span class="global-leaderboard-stats">
				${globalScore(entry)}
				${globalFirstPlaceTime(entry)}
				${globalAchievedDate(entry)}
			</span>
			<button type="button" data-snapshot-id="${escapeHtml(entry.snapshotId)}" data-player-id="${escapeHtml(entry.playerId)}">Preview</button>
		</div>
	`).join("");
rows.querySelectorAll<HTMLButtonElement>("button[data-snapshot-id]").forEach((button) => {
		button.addEventListener("click", () => void openSnapshotPreview(button.dataset.snapshotId || "", button.dataset.playerId || ""));
	});
	wireGlobalLeaderboardTooltips(rows);
}

function globalScore(entry: GlobalLeaderboardEntry) {
	return `<em class="global-leaderboard-stat" tabindex="0" data-tooltip="Top score">${entry.score}</em>`;
}

function globalFirstPlaceTime(entry: GlobalLeaderboardEntry) {
	const duration = entry.firstPlaceDurationMs ?? 0;
	if (duration <= 0) return "";
	return `<em class="global-leaderboard-stat" tabindex="0" data-tooltip="time #1">${durationClock(duration)}</em>`;
}

function globalAchievedDate(entry: GlobalLeaderboardEntry) {
	const date = new Date(entry.achievedAt);
	if (Number.isNaN(date.getTime())) return "";
	return `<em class="global-leaderboard-stat" tabindex="0" data-tooltip="${escapeHtml(formatLeaderboardTime(date))}">${escapeHtml(formatLeaderboardDate(date))}</em>`;
}

function wireGlobalLeaderboardTooltips(container: HTMLElement) {
	container.querySelectorAll<HTMLElement>(".global-leaderboard-stat[data-tooltip]").forEach((stat) => {
		stat.addEventListener("mouseenter", () => showGlobalLeaderboardTooltip(stat));
		stat.addEventListener("focus", () => showGlobalLeaderboardTooltip(stat));
		stat.addEventListener("mouseleave", hideGlobalLeaderboardTooltip);
		stat.addEventListener("blur", hideGlobalLeaderboardTooltip);
	});
	container.addEventListener("scroll", hideGlobalLeaderboardTooltip);
}

function showGlobalLeaderboardTooltip(target: HTMLElement) {
	const text = target.dataset.tooltip;
	if (!text) return;
	const tooltip = globalLeaderboardTooltip();
	tooltip.textContent = text;
	tooltip.classList.add("visible");
	const rect = target.getBoundingClientRect();
	const tooltipRect = tooltip.getBoundingClientRect();
	const x = Math.min(window.innerWidth - tooltipRect.width - 8, Math.max(8, rect.right - tooltipRect.width));
	const y = Math.max(8, rect.top - tooltipRect.height - 8);
	tooltip.style.left = `${x}px`;
	tooltip.style.top = `${y}px`;
}

function hideGlobalLeaderboardTooltip() {
	document.getElementById("globalLeaderboardTooltip")?.classList.remove("visible");
}

function globalLeaderboardTooltip() {
	let tooltip = document.getElementById("globalLeaderboardTooltip");
	if (!tooltip) {
		tooltip = document.createElement("div");
		tooltip.id = "globalLeaderboardTooltip";
		tooltip.className = "global-leaderboard-popup";
		tooltip.setAttribute("role", "tooltip");
		document.body.appendChild(tooltip);
	}
	return tooltip;
}

function formatLeaderboardDate(date: Date) {
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatLeaderboardTime(date: Date) {
	return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

function durationClock(durationMs: number) {
	const totalMinutes = Math.max(0, Math.floor(durationMs / 60000));
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

async function openSnapshotPreview(snapshotId: string, playerId?: PlayerId) {
	if (!snapshotId || !snapshotPreviewRenderer || !snapshotPreviewCanvas) return;
	const modal = document.getElementById("snapshotPreviewModal");
	const info = document.getElementById("snapshotPreviewInfo");
	modal?.classList.remove("hidden");
	setSnapshotPreviewLoading(true);
	if (info) info.textContent = "Loading snapshot...";
	const result = await getGlobalLeaderboardSnapshot(snapshotId, playerId);
	if (!result.ok || !result.snapshot) {
		setSnapshotPreviewLoading(false);
		if (info) info.textContent = result.error || "Could not load snapshot.";
		return;
	}
	previewState.snapshot = hydratePreviewSnapshot(result.snapshot);
	previewState.playerId = result.snapshot.playerId;
	previewState.selectedIds.clear();
	previewView.camera.zoom = 1;
	snapshotPreviewRenderer.resize();
	const rect = snapshotPreviewCanvas.getBoundingClientRect();
	previewView.mouse = { x: rect.width / 2, y: rect.height / 2 };
	centerPreviewCamera();
	if (info) info.textContent = "Move the mouse to the edge to pan, scroll to zoom, click units and buildings to inspect.";
	setSnapshotPreviewLoading(false);
	startPreviewLoop();
}

function closeSnapshotPreview() {
	document.getElementById("snapshotPreviewModal")?.classList.add("hidden");
	previewState.snapshot = null;
	previewState.selectedIds.clear();
	setSnapshotPreviewLoading(false);
	if (previewAnimation) cancelAnimationFrame(previewAnimation);
	previewAnimation = 0;
}

function setSnapshotPreviewLoading(loading: boolean) {
	document.getElementById("snapshotPreviewLoading")?.classList.toggle("hidden", !loading);
	snapshotPreviewCanvas?.classList.toggle("snapshot-preview-canvas-loading", loading);
}

function startPreviewLoop() {
	if (previewAnimation) return;
	const draw = () => {
		if (!previewState.snapshot || document.getElementById("snapshotPreviewModal")?.classList.contains("hidden")) {
			previewAnimation = 0;
			return;
		}
		edgePanPreview();
		snapshotPreviewRenderer?.draw(previewState, previewView);
		previewAnimation = requestAnimationFrame(draw);
	};
	previewAnimation = requestAnimationFrame(draw);
}

function beginPreviewClick(event: MouseEvent) {
	if (!snapshotPreviewCanvas) return;
	previewView.dragging = true;
	previewView.dragStart = { x: event.clientX, y: event.clientY };
}

function movePreviewMouse(event: MouseEvent) {
	if (!snapshotPreviewCanvas) return;
	const rect = snapshotPreviewCanvas.getBoundingClientRect();
	previewView.mouse = {
		x: event.clientX - rect.left,
		y: event.clientY - rect.top,
	};
}

function endPreviewClick(event: MouseEvent) {
	if (!previewView.dragging) return;
	previewView.dragging = false;
	const start = previewView.dragStart;
	previewView.dragStart = null;
	if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
	selectPreviewAt(event.clientX, event.clientY);
}

function zoomPreview(event: WheelEvent) {
	event.preventDefault();
	if (!snapshotPreviewCanvas) return;
	const rect = snapshotPreviewCanvas.getBoundingClientRect();
	const x = event.clientX - rect.left;
	const y = event.clientY - rect.top;
	const before = screenToIso(x, y, previewView.camera);
	previewView.camera.zoom = nextZoom(previewView.camera.zoom!, event.deltaY < 0 ? 1 : -1);
	const after = isoToScreen(before.x, before.y, previewView.camera);
	previewView.camera.x += x - after.x;
	previewView.camera.y += y - after.y;
	clampPreviewCamera();
}

function selectPreviewAt(clientX: number, clientY: number) {
	if (!previewState.snapshot || !snapshotPreviewCanvas) return;
	const rect = snapshotPreviewCanvas.getBoundingClientRect();
	const iso = screenToIso(clientX - rect.left, clientY - rect.top, previewView.camera);
	const hit = closestPreviewEntity(iso.x, iso.y);
	previewState.selectedIds.clear();
	if (hit) previewState.selectedIds.add(hit.id);
	const info = document.getElementById("snapshotPreviewInfo");
	if (info) info.textContent = hit ? `${labelForPreviewEntity(hit)} selected.` : "Move the mouse to the edge to pan, scroll to zoom, click units and buildings to inspect.";
}

function closestPreviewEntity(x: number, y: number) {
	const snapshot = previewState.snapshot;
	if (!snapshot) return null;
	const entities = [
		...Object.values(snapshot.units),
		...Object.values(snapshot.buildings),
		...Object.values(snapshot.resources),
		...Object.values(snapshot.corpses),
	];
	let best: Unit | Building | ResourceNode | Corpse | null = null;
	let bestDistance = Infinity;
	for (const entity of entities) {
		const cx = entity.x + entityWidth(entity) / 2;
		const cy = entity.y + entityHeight(entity) / 2;
		const distance = Math.hypot(cx - x, cy - y);
		if (distance < bestDistance && distance < Math.max(1.2, entityWidth(entity), entityHeight(entity))) {
			best = entity;
			bestDistance = distance;
		}
	}
	return best;
}

function labelForPreviewEntity(entity: Unit | Building | ResourceNode | Corpse) {
	if (entity.kind === "unit" || entity.kind === "building") {
		const owner = entity.ownerId ? previewState.snapshot?.players[entity.ownerId]?.name : null;
		return `${owner ? `${owner} ` : ""}${entity.type}`;
	}
	return entity.type;
}

function centerPreviewCamera() {
	if (!previewState.snapshot || !snapshotPreviewCanvas) return;
	const rect = snapshotPreviewCanvas.getBoundingClientRect();
	const target = previewTownCenter() ?? { x: previewState.snapshot.map.size / 2, y: previewState.snapshot.map.size / 2 };
	const center = isoToScreen(target.x, target.y, { x: 0, y: 0, zoom: previewView.camera.zoom });
	previewView.camera.x = rect.width / 2 - center.x;
	previewView.camera.y = rect.height / 2 - center.y;
	clampPreviewCamera();
}

function previewTownCenter() {
	const snapshot = previewState.snapshot;
	if (!snapshot) return null;
	const town = Object.values(snapshot.buildings).find((building) => (
		building.type === "townCenter" &&
			(!previewState.playerId || building.ownerId === previewState.playerId)
	));
	if (!town) return null;
	return {
		x: town.x + (entityWidth(town) - 1) / 2,
		y: town.y + (entityHeight(town) - 1) / 2,
	};
}

function edgePanPreview() {
	if (!previewState.snapshot || !snapshotPreviewCanvas) return;
	const rect = snapshotPreviewCanvas.getBoundingClientRect();
	const mouse = previewView.mouse;
	if (mouse.x < 0 || mouse.y < 0 || mouse.x > rect.width || mouse.y > rect.height) return;
	const margin = 28;
	const speed = 10;
	if (mouse.x <= margin) previewView.camera.x += speed;
	if (mouse.x >= rect.width - margin) previewView.camera.x -= speed;
	if (mouse.y <= margin) previewView.camera.y += speed;
	if (mouse.y >= rect.height - margin) previewView.camera.y -= speed;
	clampPreviewCamera();
}

function clampPreviewCamera() {
	if (!previewState.snapshot || !snapshotPreviewCanvas) return;
	const size = previewState.snapshot.map.size;
	const rect = snapshotPreviewCanvas.getBoundingClientRect();
	const points = [
		isoToScreen(0, 0, { x: 0, y: 0, zoom: previewView.camera.zoom }),
		isoToScreen(size, 0, { x: 0, y: 0, zoom: previewView.camera.zoom }),
		isoToScreen(0, size, { x: 0, y: 0, zoom: previewView.camera.zoom }),
		isoToScreen(size, size, { x: 0, y: 0, zoom: previewView.camera.zoom }),
	];
	const minX = Math.min(...points.map((point) => point.x));
	const maxX = Math.max(...points.map((point) => point.x));
	const minY = Math.min(...points.map((point) => point.y));
	const maxY = Math.max(...points.map((point) => point.y));
	previewView.camera.x = clampAxis(previewView.camera.x, minX, maxX, maxX - minX, rect.width, 80);
	previewView.camera.y = clampAxis(previewView.camera.y, minY, maxY, maxY - minY, rect.height, 80);
}

function onlinePlayersText(status: ServerStatus): string {
	if (status.activePlayers == 0) return "";
	if (isServerFull(status)) return "World full";
	return `${status.activePlayers} players`;
}

function isServerFull(status: ServerStatus): boolean {
	return status.activePlayers >= status.maxPlayers;
}

function setJoinButtonFull(full: boolean) {
	homeStatusFull = full;
	if (!joinButton) return;
	joinButton.disabled = full;
	joinButton.textContent = full ? "World Full" : "Play Game";
}

async function updateHomeStatus(options: { force?: boolean } = {}) {
	if (joinNotice?.textContent && !options.force) return;
	try {
		latestHomeStatus = await getStatus();
		renderHomeStatus();
	} catch {
		latestHomeStatus = null;
		renderHomeStatus();
	}
}

function renderHomeStatus() {
	const onlinePlayers = document.getElementById("onlinePlayers");
	const separator = document.getElementById("statusSeparator");
	const resetStatus = document.getElementById("resetStatus");
	const lastUpdateDate = document.getElementById("lastUpdateDate");
	const lastUpdateTime = document.getElementById("lastUpdateTime");
	const deadKingdomsCount = document.getElementById("deadKingdomsCount");
	if (!onlinePlayers && !resetStatus && !lastUpdateDate && !lastUpdateTime && !deadKingdomsCount) return;
	const status = latestHomeStatus;
	if (!status) {
		setJoinButtonFull(false);
		if (onlinePlayers) onlinePlayers.textContent = "Players online: --";
		if (resetStatus) resetStatus.textContent = "--";
		if (lastUpdateDate) lastUpdateDate.textContent = "--";
		if (lastUpdateTime) lastUpdateTime.textContent = "--";
		if (deadKingdomsCount) deadKingdomsCount.textContent = "--";
		if (separator) separator.style.display = "none";
		return;
	}
	setJoinButtonFull(isServerFull(status));
	let count = 0;
	if (onlinePlayers) {
		onlinePlayers.textContent = onlinePlayersText(status);
		count += onlinePlayers.textContent ? 1 : 0;
	}
	if (resetStatus) {
		resetStatus.textContent = formatResetStatus(status);
		count += resetStatus.textContent ? 1 : 0;
	}
	if (count > 1 && separator) separator.style.display = "inline";
	else if (separator) separator.style.display = "none";

	const updatedAt = status.lastUpdate ? new Date(status.lastUpdate) : null;
	if (lastUpdateDate) lastUpdateDate.textContent = updatedAt ? updatedAt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "--";
	if (lastUpdateTime) lastUpdateTime.textContent = updatedAt ? updatedAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : "--";
	if (deadKingdomsCount) deadKingdomsCount.textContent = status.deadKingdoms.toLocaleString();
}

function formatResetStatus(status: ServerStatus): string {
	if (status.reset.state === "active") return "";
	if (status.reset.state === "cold") return "";
	const remainingMs = Math.max(0, status.reset.resetAt! - Date.now());
	if (remainingMs == 0) return "Map reset"
	return `Map resetting in ${formatDuration(remainingMs)}`;
}

function formatDuration(ms: number) {
	const totalSeconds = Math.ceil(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes <= 0) return `${seconds}s`;
	return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function initTextScaleSetting() {
	setTextScale(storedTextScale());
}

function storedTextScale() {
	return clampTextScale(Number(localStorage.getItem(TEXT_SCALE_STORAGE_KEY)) || DEFAULT_TEXT_SCALE);
}

function setTextScale(value: number) {
	const scale = clampTextScale(value);
	document.documentElement.style.setProperty("--ui-text-scale", String(scale / 100));
	localStorage.setItem(TEXT_SCALE_STORAGE_KEY, String(scale));
	updateTextScaleControl(scale);
}

function updateTextScaleControl(scale: number) {
	const input = document.getElementById("textScaleInput");
	const value = document.getElementById("textScaleValue");
	if (input instanceof HTMLInputElement) {
		input.value = String(scale);
		input.style.setProperty("--range-progress", textScaleSliderProgress(input, scale));
	}
	if (value) value.textContent = `${scale}%`;
}

function textScaleSliderProgress(input: HTMLInputElement, scale: number) {
	const progress = (scale - MIN_TEXT_SCALE) / (MAX_TEXT_SCALE - MIN_TEXT_SCALE);
	const width = input.getBoundingClientRect().width;
	if (width <= 0) return `${progress * 100}%`;
	return `${TEXT_SCALE_SLIDER_THUMB_WIDTH / 2 + progress * (width - TEXT_SCALE_SLIDER_THUMB_WIDTH)}px`;
}

function clampTextScale(value: number) {
	if (!Number.isFinite(value)) return DEFAULT_TEXT_SCALE;
	return Math.min(MAX_TEXT_SCALE, Math.max(MIN_TEXT_SCALE, Math.round(value)));
}

async function initMusic() {
	music.audio.volume = 0.25;
	music.audio.muted = music.muted;
	music.audio.loop = false;
	music.audio.preload = "auto";
	music.audio.addEventListener("ended", () => playRandomTrack());
	updateMuteButton();
	try {
		const res = await fetch("/api/soundtrack");
		const data = await res.json();
		music.tracks = Array.isArray(data.tracks) ? data.tracks : [];
		if (!document.getElementById("game")?.classList.contains("hidden")) startMusic();
	} catch {
		music.tracks = [];
	}
}

function startMusic() {
	if (music.started || music.muted || music.tracks.length === 0) return;
	music.started = true;
	playRandomTrack();
}

function playRandomTrack() {
	if (music.muted || music.tracks.length === 0) return;
	const current = music.audio.dataset.track ?? "";
	const currentSong = songName(current);
	const differentSongs = music.tracks.filter((track) => songName(track) !== currentSong);
	const differentTracks = music.tracks.filter((track) => track !== current);
	const choices = differentSongs.length > 0 ? differentSongs : differentTracks.length > 0 ? differentTracks : music.tracks;
	const track = choices[Math.floor(Math.random() * choices.length)]!;
	music.audio.dataset.track = track;
	music.audio.src = track;
	music.audio.play().catch(() => {
		music.started = false;
	});
}

function songName(track: string) {
	if (!track) return "";
	const file = decodeURIComponent(track.split("/").pop() || "");
	return file.replace(/\.mp3$/i, "").replace(/-\d+$/i, "");
}

function toggleMusicMute() {
	sfx.unlock();
	sfx.play("music_toggle");
	music.muted = !music.muted;
	localStorage.setItem("rtsMusicMuted", String(music.muted));
	music.audio.muted = music.muted;
	if (music.muted) {
		music.audio.pause();
		music.started = false;
	} else if (music.audio.src) {
		music.started = true;
		music.audio.play().catch(() => {
			music.started = false;
		});
	} else {
		startMusic();
	}
	updateMuteButton();
}

function openSettingsModal(event?: Event) {
	event?.stopPropagation();
	const modal = document.getElementById("settingsModal");
	const button = document.getElementById("settingsButton");
	if (!modal || !button) return;
	modal.classList.remove("hidden");
	button.setAttribute("aria-expanded", "true");
	updateTextScaleControl(storedTextScale());
}

function closeSettingsModal() {
	const modal = document.getElementById("settingsModal");
	const button = document.getElementById("settingsButton");
	if (!modal || !button) return;
	modal.classList.add("hidden");
	button.setAttribute("aria-expanded", "false");
}

function closeSettingsModalOnBackdrop(event: PointerEvent) {
	const modal = document.getElementById("settingsModal");
	if (!modal || modal.classList.contains("hidden")) return;
	const target = event.target;
	if (target === modal) closeSettingsModal();
}

function closeSettingsModalOnEscape(event: KeyboardEvent) {
	const modal = document.getElementById("settingsModal");
	if (event.key !== "Escape" || !modal || modal.classList.contains("hidden")) return;
	closeSettingsModal();
}

function updateMuteButton() {
	const button = document.getElementById("settingsMuteButton");
	if (!button) return;
	button.classList.toggle("muted", music.muted);
	button.setAttribute("aria-label", music.muted ? "Unmute music" : "Mute music");
	button.title = music.muted ? "Unmute music" : "Mute music";
}

function onDevShortcutKeyDown(event: KeyboardEvent) {
	if (!state.playerId) return;
	if (event.key.length !== 1) return;
	devCommandInput = `${devCommandInput}${event.key}`.slice(-DEV_COMMAND_BUFFER_LENGTH);
	void maybeEnableAdminAccess();
	void maybeEnablePathDebug();
	void maybeSpawnZombieHorde();
}

async function maybeEnableAdminAccess() {
	if (godModeCheckPending || !state.playerId || devCommandInput.length < 3) return;
	const checkedInput = devCommandInput;
	godModeCheckPending = true;
	try {
		const result = await enableAdminAccess(state.playerId, checkedInput);
		if (result.ok) {
			adminAccessEnabled = result.enabled !== false;
			adminView = adminAccessEnabled ? "popup" : "closed";
			ui.showToast(adminAccessEnabled ? "Admin dashboard unlocked." : "Admin mode disabled.");
			connectEvents();
		}
	} catch {
		// Keep this shortcut silent unless it succeeds.
	} finally {
		godModeCheckPending = false;
		if (!adminAccessEnabled && checkedInput !== devCommandInput) void maybeEnableAdminAccess();
	}
}

async function maybeEnablePathDebug() {
	if (pathDebugEnabled || pathDebugCheckPending || !state.playerId || devCommandInput.length < 3) return;
	const checkedInput = devCommandInput;
	pathDebugCheckPending = true;
	try {
		const result = await enablePathDebug(state.playerId, checkedInput);
		if (result.ok) {
			pathDebugEnabled = true;
			ui.showToast("Pathfinding debug enabled.");
			connectEvents();
		}
	} catch {
		// Keep this shortcut silent unless it succeeds.
	} finally {
		pathDebugCheckPending = false;
		if (!pathDebugEnabled && checkedInput !== devCommandInput) void maybeEnablePathDebug();
	}
}

async function maybeSpawnZombieHorde() {
	if (!adminAccessEnabled || zombieHordePending || !state.playerId || !devCommandInput.endsWith("zombiehorde")) return;
	zombieHordePending = true;
	try {
		const result = await spawnZombieHorde(state.playerId, 500);
		if (result.ok) ui.showToast(`Spawned ${result.spawned ?? 500} zombies.`);
	} catch {
		// Keep this shortcut silent unless it succeeds.
	} finally {
		zombieHordePending = false;
	}
}

function connectEvents() {
	if (eventStream) eventStream.close();
	if (!state.playerId) return;
	eventStream = new EventSource(`/events?playerId=${encodeURIComponent(state.playerId)}&adminView=${encodeURIComponent(adminView)}`);
	eventStream.onmessage = (event) => {
		const snap = snapshotFromMessage(JSON.parse(event.data) as SnapshotMessage);
		if (!snap) {
			connectEvents();
			return;
		}
		if (!state.playerId || !snap.players?.[state.playerId] || snap.players[state.playerId]!.defeated) {
			handleEliminated();
			return;
		}
		applyVisibility(snap);
		state.snapshot = snap;
		adminDiagnosticsVisible = snap.admin !== null;
		if (snap.admin !== null) adminAccessEnabled = true;
		if (adminDiagnosticsVisible) maybeReportPing(Math.max(0, Date.now() - snap.now));
		rememberStaticObjects();
		cullSelection();
		ui.render();
		sfx.observe(snap);
		centerOnTownOnce();
	};
	eventStream.onerror = () => ui.showToast("Connection interrupted.");
}

function snapshotFromMessage(message: SnapshotMessage): ClientSnapshot | null {
	if (message.type === "snapshot") {
		lastSnapshotSeq = message.seq ?? 0;
		return hydrateSnapshot(message);
	}
	if (!state.snapshot || message.baseSeq !== lastSnapshotSeq) return null;
	const merged = mergeSnapshotDelta(state.snapshot, message);
	lastSnapshotSeq = message.seq;
	return hydrateSnapshot(merged);
}

function maybeReportPing(pingMs: number) {
	if (!state.playerId || Date.now() - lastPingReportAt < 2000) return;
	lastPingReportAt = Date.now();
	void reportPing(state.playerId, pingMs);
}

async function leaveCurrentGame(message: string) {
	if (state.playerId) await leave(state.playerId);
	resetToJoin(message);
}

function handleEliminated() {
	resetToJoin("You were eliminated. Join again to restart.");
}

function resetToJoin(message: string) {
	if (eventStream) eventStream.close();
	eventStream = null;
	lastSnapshotSeq = 0;
	localStorage.removeItem("rtsPlayerId");
	state.playerId = null;
	state.snapshot = null;
	adminDiagnosticsVisible = false;
	adminAccessEnabled = false;
	adminView = "closed";
	state.selectedIds.clear();
	state.effects = [];
	sfx.reset();
	centered = false;
	document.getElementById("game")?.classList.add("hidden");
	document.getElementById("join")?.classList.remove("hidden");
	const notice = document.getElementById("joinNotice");
	if (notice) notice.textContent = message || "";
	if (message) ui.showToast(message);
}

function isAdminView(value: string): value is typeof adminView {
	return value === "closed" || value === "popup" || value === "overview" || value === "performance" || value === "players" || value === "logs" || value === "devCommands" || value === "bans";
}

function applyVisibility(snap: ClientSnapshot) {
	if (!snap.visibility) return;
	if (Array.isArray(snap.visibility.explored)) {
		// Initial / full set
		state.exploredSet = new Set(snap.visibility.explored);
	} else if (Array.isArray(snap.visibility.exploredDelta)) {
		for (const key of snap.visibility.exploredDelta) state.exploredSet.add(key);
	}
	snap.visibility.visibleSet = new Set(snap.visibility.visible);
	snap.visibility.exploredSet = state.exploredSet;
}

function hydrateSnapshot(snap: Snapshot): ClientSnapshot {
	const buildings = Object.fromEntries(
		Object.entries(snap.buildings).map(([id, building]) => [id, deserializeBuilding(building)]),
	) as ClientSnapshot["buildings"];
	return {
		...snap,
		buildings,
		corpses: snap.corpses || {},
		dayNight: offsetDayNight(snap.dayNight, state.timeOffsetSeconds),
	};
}

function mergeSnapshotDelta(previous: ClientSnapshot, delta: SnapshotDelta): Snapshot {
	return {
		type: "snapshot",
		seq: delta.seq,
		now: delta.now,
		playerId: delta.playerId,
		map: previous.map,
		players: patchRecord(previous.players, delta.players),
		units: patchRecord(previous.units, delta.units),
		buildings: patchRecord(Object.fromEntries(Object.entries(previous.buildings).map(([id, building]) => [id, building.serialize()])), delta.buildings),
		resources: patchRecord(previous.resources, delta.resources),
		ruins: patchRecord(previous.ruins, delta.ruins),
		corpses: patchRecord(previous.corpses, delta.corpses),
		visibility: delta.visibility,
		dayNight: delta.dayNight,
		leaderboard: delta.leaderboard,
		notices: delta.notices,
		hornSounds: delta.hornSounds,
		soundDebug: delta.soundDebug,
		pathDebug: delta.pathDebug,
		serverPerf: delta.serverPerf,
		admin: delta.admin,
	};
}

function patchRecord<T>(previous: Record<string, T>, delta: { updated: Record<string, T>; removed: string[] }): Record<string, T> {
	const next = { ...previous };
	for (const id of delta.removed) delete next[id];
	for (const [id, value] of Object.entries(delta.updated)) next[id] = value as T;
	return next;
}

function hydratePreviewSnapshot(snap: LeaderboardPreviewSnapshot): ClientSnapshot {
	const snapshot: Snapshot = {
		type: "snapshot",
		now: snap.now,
		playerId: snap.playerId,
		map: snap.map,
		players: Object.fromEntries(Object.entries(snap.players).map(([id, player]) => [
			id,
			{
				...player,
				resources: { wood: 0, food: 0, ore: 0 },
				autoReplenishFarms: false,
				population: 0,
				popCap: 0,
				workerCounts: { idle: 0, gathering: { wood: 0, food: 0, ore: 0 } },
				joinedAt: 0,
			},
		])),
		units: Object.fromEntries(Object.entries(snap.units).map(([id, unit]) => [
			id,
			{
				...unit,
				hp: 1,
				maxHp: 1,
				command: { type: "idle" },
				cooldown: 0,
				attackFlash: 0,
				workFlash: 0,
				carried: null,
				selected: false,
			},
		])),
		buildings: Object.fromEntries(Object.entries(snap.buildings).map(([id, building]) => [
			id,
			{
				...building,
				hp: 1,
				maxHp: 1,
				completed: true,
				repairPaidUntilHp: undefined,
				builderIds: [],
				queue: [],
			},
		])),
		resources: Object.fromEntries(Object.entries(snap.resources).map(([id, resource]) => [
			id,
			{
				...resource,
				amount: 1,
				maxAmount: 1,
			},
		])),
		ruins: Object.fromEntries(Object.entries(snap.ruins).map(([id, ruin]) => [
			id,
			{
				...ruin,
				age: 0,
			},
		])),
		corpses: Object.fromEntries(Object.entries(snap.corpses).map(([id, corpse]) => [
			id,
			{
				...corpse,
				hp: 0,
				maxHp: 1,
				remaining: 1,
			},
		])),
		visibility: null,
		dayNight: dayNightStateAt(0),
		leaderboard: [],
		notices: [],
		hornSounds: [],
		soundDebug: null,
		pathDebug: false,
		serverPerf: null,
		admin: null,
	};
	return hydrateSnapshot(snapshot);
}

function offsetDayNight(dayNight: ClientSnapshot["dayNight"], offsetSeconds: number) {
	if (!offsetSeconds) return dayNight;
	return dayNightStateAt(dayNight.cycleProgress * DAY_NIGHT_CYCLE_SECONDS + offsetSeconds);
}

let centered = false;
function centerOnTownOnce() {
	if (centered || !state.snapshot) return;
	centerOnTown(true);
}

function centerOnTown(once = true) {
	if (!state.snapshot) return;
	if (once && centered) return;
	const town = Object.values(state.snapshot.buildings).find((building) => building.ownerId === state.playerId && building.type === "townCenter");
	if (!town) return;
	const screen = isoToScreen(town.x + (town.size - 1) / 2, town.y + (town.size - 1) / 2, { x: 0, y: 0, zoom: view.camera.zoom });
	view.camera.x = window.innerWidth / 2 - screen.x;
	view.camera.y = window.innerHeight / 2 - screen.y;
	clampCamera();
	centered = true;
}

function drawLoop() {
	updateFpsStat();
	edgePan();
	pruneEffects();
	renderer.draw(state, view);
	requestAnimationFrame(drawLoop);
}

function updateFpsStat() {
	if (!adminDiagnosticsVisible) {
		lastFrameAt = performance.now();
		return;
	}
	const now = performance.now();
	const dt = Math.max(1, now - lastFrameAt);
	lastFrameAt = now;
	const fps = 1000 / dt;
	smoothedFps = smoothedFps * 0.9 + fps * 0.1;
	const el = document.getElementById("fps");
	if (el) el.textContent = `FPS ${Math.round(smoothedFps)}`;
}

function onMouseDown(event: MouseEvent) {
	sfx.unlock();
	if (event.button === 1 || (event.shiftKey && event.button !== 0)) {
		view.panning = true;
		view.panLast = { x: event.clientX, y: event.clientY };
		return;
	}
	if (event.button === 2) return handleRightClick(event);
	view.dragging = true;
	view.dragStart = { x: event.clientX, y: event.clientY };
	view.dragCurrent = { x: event.clientX, y: event.clientY };
	view.wallDragStartTile = view.buildMode === "wall" && view.hoverTile ? { ...view.hoverTile } : null;
}

function onMouseMove(event: MouseEvent) {
	const iso = screenToIso(event.clientX, event.clientY, view.camera);
	view.hoverTile = { x: Math.floor(iso.x), y: Math.floor(iso.y) };
	if (view.panning) {
		view.camera.x += event.clientX - view.panLast!.x;
		view.camera.y += event.clientY - view.panLast!.y;
		clampCamera();
		view.panLast = { x: event.clientX, y: event.clientY };
	}
	if (view.dragging) view.dragCurrent = { x: event.clientX, y: event.clientY };
}

function trackMousePosition(event: MouseEvent) {
	view.mouse = { x: event.clientX, y: event.clientY };
}

function onMouseUp(event: MouseEvent) {
	if (view.panning) {
		view.panning = false;
		return;
	}
	if (!view.dragging || event.button !== 0) return;
	view.dragging = false;
	const dx = Math.abs(view.dragCurrent!.x - view.dragStart!.x);
	const dy = Math.abs(view.dragCurrent!.y - view.dragStart!.y);
	if (view.noiseMode) {
		emitNoiseFromScreen(event.clientX, event.clientY);
		return;
	}
	if (view.buildMode) {
		placeBuildMode();
		return;
	}
	if (view.rallyModeBuildingId) {
		setRallyPointFromScreen(event.clientX, event.clientY);
		return;
	}
	if (dx < 5 && dy < 5) selectAt(event.clientX, event.clientY, event.shiftKey);
		else selectBox(event.shiftKey);
	ui.render();
}

function handleRightClick(event: MouseEvent) {
	if (view.buildMode) {
		view.buildMode = null;
		view.wallDragStartTile = null;
		return;
	}
	view.wallDragStartTile = null;
	view.rallyModeBuildingId = null;
	if (view.noiseMode) {
		view.noiseMode = false;
		ui.showToast("Noise tool off.");
		return;
	}
	const hit = hitTest(event.clientX, event.clientY);
	const ownUnits = [...state.selectedIds].filter((id) => state.snapshot?.units[id]?.ownerId === state.playerId);
	if (ownUnits.length === 0 && selectedProductionBuilding()) {
		setRallyPointFromScreen(event.clientX, event.clientY, selectedProductionBuilding()!.id);
		return;
	}
	if (ownUnits.length === 0) return;
	if (hit?.kind === "building" && hit.ownerId === state.playerId && hit.hp < hit.maxHp) {
		issue({ type: "finishBuild", unitIds: ownUnits, buildingId: hit.id }, { silent: true }).then((result) => {
			addTargetFlash(hit.id, result.ok ? "white" : "red");
			sfx.play(result.ok ? "ui_command_build" : "ui_error", { point: hit });
		});
	} else if (hit?.kind === "resource" || (hit?.kind === "building" && canGatherFromClickTarget(hit))) {
		issue({ type: "gather", unitIds: ownUnits, targetId: hit.id }, { silent: true }).then((result) => {
			addTargetFlash(hit.id, result.ok ? "white" : "red");
			sfx.play(result.ok ? commandSoundForTarget(hit) : "ui_error", { point: hit });
		});
	} else if (isAttackClickTarget(hit)) {
		const target = hit;
		issue({ type: "attack", unitIds: ownUnits, targetId: target.id }, { silent: true }).then((result) => {
			addTargetFlash(target.id, result.ok ? "white" : "red");
			sfx.play(result.ok ? "ui_command_attack" : "ui_error", { point: target });
		});
	} else {
		const iso = screenToIso(event.clientX, event.clientY, view.camera);
		issue({ type: "move", unitIds: ownUnits, x: iso.x, y: iso.y }).then((result) => {
			if (result.ok) addMoveCross(iso.x, iso.y);
			sfx.play(result.ok ? "ui_command_move" : "ui_error", { point: iso });
		});
	}
}

function canGatherFromClickTarget(target: Building) {
	return target.canBeGatheredBy(state.playerId!) || (target.ownerId === state.playerId && target.isComplete() && !!target.depotGatherKind());
}

function isAttackClickTarget(target: Unit | Building | ResourceNode | Corpse | null): target is Unit | Building | Corpse {
	if (!target) return false;
	if (target.kind === "corpse") return true;
	return !!target.ownerId && target.ownerId !== state.playerId;
}

function emitNoiseFromScreen(x: number, y: number) {
	if (!state.playerId) return;
	const iso = screenToIso(x, y, view.camera);
	void requestEmitNoise(state.playerId, iso.x, iso.y);
	addMoveCross(iso.x, iso.y);
}

function setRallyPointFromScreen(x: number, y: number, buildingId = view.rallyModeBuildingId) {
	if (!buildingId) return;
	const hit = hitTest(x, y);
	const iso = screenToIso(x, y, view.camera);
	const rallyPoint = hit?.kind === "building" ? centerOfEntity(hit) : iso;
	const targetId = hit?.kind === "building" ? hit.id : undefined;
	issue({ type: "setRallyPoint", buildingId, x: rallyPoint.x, y: rallyPoint.y, targetId }, { silent: true }).then((result) => {
		if (result.ok && targetId) addTargetFlash(targetId, "white");
		else if (result.ok) addMoveCross(rallyPoint.x, rallyPoint.y);
		sfx.play(result.ok ? "ui_command_move" : "ui_error", { point: rallyPoint });
	});
	view.rallyModeBuildingId = null;
}

function centerOfEntity(entity: { x: number; y: number; size?: number; width?: number; height?: number }) {
	return {
		x: entity.x + ((entity.width ?? entity.size ?? 1) - 1) / 2,
		y: entity.y + ((entity.height ?? entity.size ?? 1) - 1) / 2,
	};
}

function placeBuilding() {
	const mode = view.buildMode;
	if (!mode) return;
	const unitIds = [...state.selectedIds].filter((id) => state.snapshot?.units[id]?.ownerId === state.playerId);
	if (!view.hoverTile || (!view.instantBuildMode && unitIds.length === 0)) return;
	if ((!view.instantBuildMode && !canAffordBuildAt(mode as BuildingType, view.hoverTile.x, view.hoverTile.y)) || !canPlacePreview(mode as BuildingType, view.hoverTile.x, view.hoverTile.y)) {
		ui.showToast("Cannot place that building there.");
		sfx.play("ui_error");
		return;
	}
	const buildPoint = { x: view.hoverTile.x, y: view.hoverTile.y };
	const command = view.instantBuildMode
		? { type: "instantBuild" as const, buildingType: mode as BuildingType, x: buildPoint.x, y: buildPoint.y }
		: { type: "build" as const, unitIds, buildingType: mode as BuildingType, x: buildPoint.x, y: buildPoint.y };
	issue(command).then((result) => {
		sfx.play(result.ok ? buildingCommandSound(mode) : "ui_error", { point: buildPoint });
	});
	view.buildMode = null;
	view.wallDragStartTile = null;
}

function placeBuildMode() {
	if (view.buildMode === "wall" && view.wallDragStartTile && view.hoverTile) return placeWallLine();
	placeBuilding();
}

async function placeWallLine() {
	const unitIds = [...state.selectedIds].filter((id) => state.snapshot?.units[id]?.ownerId === state.playerId);
	const tiles = wallLineTiles();
	if (!tiles.length || (!view.instantBuildMode && unitIds.length === 0)) return;
	if ((!view.instantBuildMode && !canAffordLine("wall", tiles)) || tiles.some((tile) => !canPlacePreview("wall", tile.x, tile.y))) {
		ui.showToast("Cannot place that wall there.");
		sfx.play("ui_error");
		return;
	}
	view.buildMode = null;
	view.wallDragStartTile = null;
	for (const tile of tiles) {
		const command = view.instantBuildMode
			? { type: "instantBuild" as const, buildingType: "wall" as const, x: tile.x, y: tile.y }
			: { type: "build" as const, unitIds, buildingType: "wall" as const, x: tile.x, y: tile.y };
		const result = await issue(command);
		sfx.play(result.ok ? "ui_command_build" : "ui_error", { point: tile, cooldownKey: "wall_line_build" });
		if (!result.ok) break;
	}
}

async function issue(payload: ClientCommand, options: { silent?: boolean } = {}) {
	if (!state.playerId) return { ok: false };
	const result = await sendCommand({ ...payload, playerId: state.playerId } as unknown as CommandPayload);
	if (!result.ok && !options.silent) {
		ui.showToast(result.error || "Command failed.");
		sfx.play(result.error?.includes("Population") ? "population_blocked" : "ui_error");
	}
	return result;
}

function errorMessage(result: { ok: boolean; error?: string }) {
	return result.error || "";
}

function addMoveCross(x: number, y: number) {
	state.effects.push({ type: "moveCross", x, y, createdAt: performance.now(), duration: 850 });
}

function addTargetFlash(targetId: EntityId, color = "white") {
	state.effects.push({ type: "targetFlash", targetId, color, createdAt: performance.now(), duration: 520 });
}

function pruneEffects() {
	const now = performance.now();
	state.effects = state.effects.filter((effect) => now - effect.createdAt < effect.duration);
}

function selectAt(x: number, y: number, additive = false) {
	const hit = hitTestForSelection(x, y);
	if (!additive) state.selectedIds.clear();
	if (additive && hit?.kind !== "unit") return;
	if (hit) state.selectedIds.add(hit.id);
	if (hit?.kind === "unit") sfx.play("ui_select_unit", { point: hit });
	else if (hit?.kind === "building") sfx.play("ui_select_building", { point: hit });
}

function selectBox(additive = false) {
	if (!state.snapshot) return;
	if (!additive) state.selectedIds.clear();
	const left = Math.min(view.dragStart!.x, view.dragCurrent!.x);
	const right = Math.max(view.dragStart!.x, view.dragCurrent!.x);
	const top = Math.min(view.dragStart!.y, view.dragCurrent!.y);
	const bottom = Math.max(view.dragStart!.y, view.dragCurrent!.y);
	if (!state.snapshot) return;
	for (const unit of Object.values(state.snapshot.units)) {
		if (unit.ownerId !== state.playerId) continue;
		const p = isoToScreen(unit.x, unit.y, view.camera);
		if (p.x >= left && p.x <= right && p.y >= top - 40 && p.y <= bottom) state.selectedIds.add(unit.id);
	}
	if (state.selectedIds.size > 0) sfx.play("ui_select_unit", { volume: Math.min(1.7, 0.9 + state.selectedIds.size * 0.05) });
}

function onKeyDown(event: KeyboardEvent) {
	sfx.unlock();
	if (document.getElementById("game")?.classList.contains("hidden") || (event.target as HTMLElement)?.matches?.("input, button")) return;
	const key = event.key.toLowerCase();
	if (key === "escape") {
		view.buildMode = null;
		view.wallDragStartTile = null;
		if (view.noiseMode) {
			view.noiseMode = false;
			ui.showToast("Noise tool off.");
		}
		state.selectedIds.clear();
		ui.render();
		return;
	}
	if (key === "+" || key === "=") return setZoom(nextZoom(view.camera.zoom!, 1));
	if (key === "-" || key === "_") return setZoom(nextZoom(view.camera.zoom!, -1));
	if (key === " ") {
		event.preventDefault();
		return centerOnTown(false);
	}
	if ((event.metaKey || event.ctrlKey) && key === "a") {
		event.preventDefault();
		for (const unit of Object.values(state.snapshot?.units || {})) {
			if (unit.ownerId === state.playerId) state.selectedIds.add(unit.id);
		}
		ui.render();
		return;
	}
	if (key === "delete" || key === "backspace") return deleteSelectedBuilding();
	if (key === ".") return selectIdleWorkers();
	const buildShortcuts: Record<string, string> = { h: "house", f: "farm", b: "barracks", t: "watchTower", w: "wall", g: "gate", l: "lumberCamp", d: "foodDepot", m: "miningCamp" };
	if (buildShortcuts[key]) return startBuildShortcut(buildShortcuts[key] as BuildingType);
	const shortcutUnit = unitTypeForShortcut(key);
	if (shortcutUnit) return trainShortcut(shortcutUnit);
	if (key === "r") return selectedFarmAction((farm) => issue({ type: "replenishFarm", farmId: farm.id }));
	if (key === "a") return selectedFarmAction(() => issue({ type: "toggleAutoFarm" }));
	if (key === "o") return blowHornForSelectedScouts();
	if (key === "y") return setRallyForSelectedProduction();
}

function startBuildShortcut(buildingType: BuildingType) {
	const hasBuilder = [...state.selectedIds].some((id) => {
		const unit = state.snapshot?.units[id];
		return unit?.ownerId === state.playerId && unitBehavior(unit).canBuild;
	});
	if (!view.instantBuildMode && !hasBuilder) {
		sfx.play("ui_error");
		return ui.showToast("Select build-capable units.");
	}
	const def = BUILDING_TYPES[buildingType as keyof typeof BUILDING_TYPES];
	if (!def) return;
	if (!view.instantBuildMode && buildingType !== "gate" && !canAfford(def.cost || {})) {
		sfx.play("ui_error");
		return ui.showToast("Not enough resources.");
	}
	view.buildMode = buildingType;
	ui.showToast(`Place ${def.label}.`);
	sfx.play(buildingCommandSound(buildingType));
}

function trainShortcut(unitType: UnitType) {
	if (!state.snapshot || !state.playerId) return;
	const building = [...state.selectedIds].map((id) => state.snapshot?.buildings[id]).find((entity) => {
		if (!entity || entity.ownerId !== state.playerId) return false;
		return ((TRAINING as Record<string, readonly { unitType: string; cost: Record<string, number> }[]>)[entity.type] || []).some((train) => train.unitType === unitType);
	});
	if (!building) return;
	const train = ((TRAINING as Record<string, readonly { unitType: string; cost: Record<string, number> }[]>)[building.type] || []).find((item) => item.unitType === unitType);
	const player = state.snapshot.players[state.playerId]!;
	if (!train || !canAfford(train.cost || {})) {
		sfx.play("ui_error");
		return ui.showToast("Not enough resources.");
	}
	if (player.population >= player.popCap) {
		sfx.play("population_blocked");
		return ui.showToast("Population cap reached.");
	}
	if ((building.queue?.length ?? 0) >= 10) {
		sfx.play("ui_error");
		return ui.showToast("Training queue is full.");
	}
	issue({ type: "train", buildingId: building.id, unitType }).then((result) => {
		sfx.play(result.ok ? "train_queue" : "ui_error", { point: building });
	});
}

function selectedFarmAction(action: (farm: Building) => void) {
	const farm = [...state.selectedIds].map((id) => state.snapshot?.buildings[id]).find((entity) => entity?.ownerId === state.playerId && entity.gatherResource);
	if (farm) action(farm);
}

function blowHornForSelectedScouts() {
	const unitIds = [...state.selectedIds].map((id) => state.snapshot?.units[id]).filter((unit): unit is Unit => (
		!!unit &&
		unit.ownerId === state.playerId &&
		unit.type === "scout"
	)).map((unit) => unit.id);
	if (unitIds.length === 0) {
		sfx.play("ui_error");
		return ui.showToast("Select a scout.");
	}
	issue({ type: "blowHorn", unitIds }).then((result) => {
		if (!result.ok) sfx.play("ui_error");
	});
}

function deleteSelectedBuilding() {
	const building = [...state.selectedIds].map((id) => state.snapshot?.buildings[id]).find((entity) => entity?.ownerId === state.playerId);
	if (building) issue({ type: "deleteBuilding", buildingId: building.id }).then((result) => {
		sfx.play(result.ok ? "building_destroyed" : "ui_error", { point: building });
	});
}

function selectIdleWorkers() {
	const idle = Object.values(state.snapshot?.units || {})
	.filter((unit) => unit.ownerId === state.playerId && unitBehavior(unit).canGather && (!unit.command || unit.command.type === "idle"))
	.sort((a, b) => a.id.localeCompare(b.id));
	state.selectedIds.clear();
	if (idle.length > 0) {
		state.idleWorkerCycleIndex = (state.idleWorkerCycleIndex + 1) % idle.length;
		state.selectedIds.add(idle[state.idleWorkerCycleIndex]!.id);
	} else {
		state.idleWorkerCycleIndex = -1;
	}
	ui.render();
}

function selectedProductionBuilding() {
	return [...state.selectedIds]
		.map((id) => state.snapshot?.buildings[id])
		.find((building) => building?.ownerId === state.playerId && ((TRAINING as Record<string, unknown[]>)[building.type] || []).length > 0);
}

function setRallyForSelectedProduction() {
	const building = selectedProductionBuilding();
	if (!building) return;
	view.rallyModeBuildingId = building.id;
	ui.showToast("Choose a rally point.");
}

function setZoom(zoom: number) {
	view.camera.zoom = zoom;
	clampCamera();
}

function canAfford(cost: Partial<Record<ResourceType, number>> = {}) {
	const resources: Record<string, number> = state.snapshot?.players[state.playerId!]?.resources || {};
	return Object.entries(cost).every(([resource, amount]) => (resources[resource] || 0) >= (amount as number));
}

function canAffordBuildAt(buildingType: BuildingType, x: number, y: number) {
	return canAfford(effectiveBuildCost(buildingType, x, y));
}

function effectiveBuildCost(buildingType: BuildingType, x: number, y: number) {
	const cost = { ...(BUILDING_TYPES[buildingType as keyof typeof BUILDING_TYPES]?.cost || {}) } as Partial<Record<ResourceType, number>>;
	const wall = ownWallAt(x, y);
	if (buildingType !== "gate" || !wall || wall.completed) return cost;
	for (const [resource, amount] of Object.entries(BUILDING_TYPES.wall.cost) as [ResourceType, number][]) {
		cost[resource] = Math.max(0, (cost[resource] || 0) - amount);
	}
	return cost;
}

function canAffordLine(buildingType: BuildingType, tiles: { x: number; y: number }[]) {
	const cost = BUILDING_TYPES[buildingType as keyof typeof BUILDING_TYPES]?.cost || {};
	const multiplier = tiles.filter((tile) => !ownWallAt(tile.x, tile.y)).length;
	const total = Object.fromEntries(Object.entries(cost).map(([resource, amount]) => [resource, (amount as number) * multiplier])) as Partial<Record<ResourceType, number>>;
	return canAfford(total);
}

function wallLineTiles() {
	if (!view.wallDragStartTile || !view.hoverTile) return [];
	const start = view.wallDragStartTile;
	const end = view.hoverTile;
	const axis = closestWallAxis(start, end);
	const length = Math.max(0, Math.round(axis.length));
	const tiles = [];
	for (let index = 0; index <= length; index += 1)
		tiles.push({ x: start.x + axis.dx * index, y: start.y + axis.dy * index });
	return tiles;
}

function closestWallAxis(start: { x: number; y: number }, end: { x: number; y: number }) {
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const axes = [
		{ dx: dx >= 0 ? 1 : -1, dy: 0, length: Math.abs(dx), distance: Math.abs(dy) },
		{ dx: 0, dy: dy >= 0 ? 1 : -1, length: Math.abs(dy), distance: Math.abs(dx) },
		{ dx: dx - dy >= 0 ? 1 : -1, dy: dx - dy >= 0 ? -1 : 1, length: Math.abs(dx - dy) / 2, distance: Math.abs(dx + dy) },
		{ dx: dx + dy >= 0 ? 1 : -1, dy: dx + dy >= 0 ? 1 : -1, length: Math.abs(dx + dy) / 2, distance: Math.abs(dx - dy) },
	];
	return axes.sort((a, b) => a.distance - b.distance || b.length - a.length)[0]!;
}

function canPlacePreview(buildingType: BuildingType, x: number, y: number) {
	if (!state.snapshot || !BUILDING_TYPES[buildingType as keyof typeof BUILDING_TYPES]) return false;
	const footprint = buildingFootprint(buildingType);
	const replacementWall = ownWallAt(x, y);
	if (buildingType === "wall" && replacementWall) return true;
	if (x < 0 || y < 0 || x + footprint.width > state.snapshot.map.size || y + footprint.height > state.snapshot.map.size) return false;
	for (const building of Object.values(state.snapshot.buildings)) {
		if (buildingType === "gate" && replacementWall && building.id === replacementWall.id) continue;
		if (rectsOverlap({ x, y, ...footprint }, building)) return false;
	}
	for (const resource of Object.values(state.snapshot.resources)) {
		if (pointInFootprint(Math.floor(resource.x), Math.floor(resource.y), x, y, footprint)) return false;
	}
	for (const corpse of Object.values(state.snapshot.corpses)) {
		if (pointInFootprint(Math.floor(corpse.x), Math.floor(corpse.y), x, y, footprint)) return false;
	}
	return true;
}

function ownWallAt(x: number, y: number) {
	return Object.values(state.snapshot?.buildings || {}).find((building) => (
		building.ownerId === state.playerId &&
		building.type === "wall" &&
		building.x === x &&
		building.y === y
	)) || null;
}

function buildingSize(type: BuildingType) {
	if (type in BUILDING_TYPES) return BUILDING_TYPES[type as keyof typeof BUILDING_TYPES].size;
	if (type === "barracks") return 3;
	if (type === "house") return 2;
	return 1;
}

function buildingFootprint(type: BuildingType): { width: number; height: number } {
	const def = BUILDING_TYPES[type as keyof typeof BUILDING_TYPES];
	const size = buildingSize(type);
	return {
		width: (def && "width" in def ? def.width : size) as number,
		height: (def && "height" in def ? def.height : size) as number,
	};
}

function rectsOverlap(a: { x: number; y: number; size?: number; width?: number; height?: number }, b: { x: number; y: number; size?: number; width?: number; height?: number }) {
	const aw = a.width ?? a.size ?? 1;
	const ah = a.height ?? a.size ?? 1;
	const bw = b.width ?? b.size ?? 1;
	const bh = b.height ?? b.size ?? 1;
	return a.x < b.x + bw && a.x + aw > b.x && a.y < b.y + bh && a.y + ah > b.y;
}

function pointInFootprint(px: number, py: number, x: number, y: number, footprint: { width: number; height: number }) {
	return px >= x && px < x + footprint.width && py >= y && py < y + footprint.height;
}

function edgePan() {
	const game = document.getElementById("game");
	if (!game || game.classList.contains("hidden")) return;
	const speed = 10;
	if (view.mouse.x <= EDGE_PAN_MARGIN) view.camera.x += speed;
	if (view.mouse.x >= window.innerWidth - EDGE_PAN_MARGIN) view.camera.x -= speed;
	if (view.mouse.y <= EDGE_PAN_MARGIN) view.camera.y += speed;
	if (view.mouse.y >= window.innerHeight - EDGE_PAN_MARGIN) view.camera.y -= speed;
	clampCamera();
}

function nextZoom(current: number, direction: number) {
	const index = ZOOM_STEPS.reduce((best, value, i) => (
		Math.abs(value - current) < Math.abs(ZOOM_STEPS[best]! - current) ? i : best
	), 0);
	return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, index + direction))]!;
}

function moveCameraFromMinimap(event: MouseEvent) {
	if (!state.snapshot) return;
	if (event.button === 2) return;
	const rect = (minimap as HTMLCanvasElement).getBoundingClientRect();
	const point = minimapScreenToIso(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height, state.snapshot.map.size);
	const x = Math.max(0, Math.min(state.snapshot.map.size - 1, point.x));
	const y = Math.max(0, Math.min(state.snapshot.map.size - 1, point.y));
	const screen = isoToScreen(x, y, { x: 0, y: 0, zoom: view.camera.zoom });
	view.camera.x = window.innerWidth / 2 - screen.x;
	view.camera.y = window.innerHeight / 2 - screen.y;
	clampCamera();
}

function onMinimapMouseDown(event: MouseEvent) {
	if (event.button !== 2 || !state.snapshot) return;
	event.preventDefault();
	const point = minimapEventToIso(event);
	const ownUnits = [...state.selectedIds].filter((id) => state.snapshot?.units[id]?.ownerId === state.playerId);
	if (ownUnits.length === 0 && selectedProductionBuilding()) {
		const building = selectedProductionBuilding()!;
		issue({ type: "setRallyPoint", buildingId: building.id, x: point.x, y: point.y }).then((result) => {
			if (result.ok) addMoveCross(point.x, point.y);
		});
		return;
	}
	if (ownUnits.length === 0) return;
	issue({ type: "move", unitIds: ownUnits, x: point.x, y: point.y }).then((result) => {
		if (result.ok) addMoveCross(point.x, point.y);
	});
}

function minimapEventToIso(event: MouseEvent) {
	if (!state.snapshot) return { x: 0, y: 0 };
	const rect = (minimap as HTMLCanvasElement).getBoundingClientRect();
	const point = minimapScreenToIso(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height, state.snapshot.map.size);
	const mapSize = state.snapshot.map.size;
	return {
		x: Math.max(0, Math.min(mapSize - 1, point.x)),
		y: Math.max(0, Math.min(mapSize - 1, point.y)),
	};
}

function clampCamera() {
	if (!state.snapshot) return;
	const size = state.snapshot.map.size;
	const points = [
		isoToScreen(0, 0, { x: 0, y: 0, zoom: view.camera.zoom }),
		isoToScreen(size, 0, { x: 0, y: 0, zoom: view.camera.zoom }),
		isoToScreen(0, size, { x: 0, y: 0, zoom: view.camera.zoom }),
		isoToScreen(size, size, { x: 0, y: 0, zoom: view.camera.zoom }),
	];
	const minX = Math.min(...points.map((point) => point.x));
	const maxX = Math.max(...points.map((point) => point.x));
	const minY = Math.min(...points.map((point) => point.y));
	const maxY = Math.max(...points.map((point) => point.y));
	const mapW = maxX - minX;
	const mapH = maxY - minY;
	const margin = 160;
	view.camera.x = clampAxis(view.camera.x, minX, maxX, mapW, window.innerWidth, margin);
	view.camera.y = clampAxis(view.camera.y, minY, maxY, mapH, window.innerHeight, margin);
}

function clampAxis(cameraValue: number, mapMin: number, mapMax: number, mapSpan: number, viewSpan: number, margin: number) {
	if (mapSpan + margin * 2 <= viewSpan) {
		return viewSpan / 2 - (mapMin + mapMax) / 2;
	}
	const low = viewSpan - margin - mapMax;
	const high = margin - mapMin;
	return Math.max(low, Math.min(high, cameraValue));
}

function clamp(value: number, min: number, max: number) {
	return Math.max(min, Math.min(max, value));
}

function minimapScreenToIso(px: number, py: number, width: number, height: number, size: number) {
	const usableW = width - 12;
	const usableH = height - 12;
	const a = ((px - width / 2) / (usableW / 2)) * size;
	const b = ((py - height / 2) / (usableH / 2)) * size + size;
	return {
		x: (a + b) / 2,
		y: (b - a) / 2,
	};
}

function rememberStaticObjects() {
	if (!state.snapshot) return;
	forgetVisibleMissing(state.lastSeen.buildings, state.snapshot.buildings);
	forgetVisibleMissing(state.lastSeen.resources, state.snapshot.resources);
	forgetVisibleMissing(state.lastSeen.ruins, state.snapshot.ruins);
	for (const [id, building] of Object.entries(state.snapshot.buildings)) state.lastSeen.buildings[id] = building;
	for (const [id, resource] of Object.entries(state.snapshot.resources)) state.lastSeen.resources[id] = resource;
	for (const [id, ruin] of Object.entries(state.snapshot.ruins)) state.lastSeen.ruins[id] = ruin;
}

function forgetVisibleMissing(memory: Record<string, Building | ResourceNode | { x: number; y: number; size?: number; width?: number; height?: number }>, current: Record<string, Building | ResourceNode | Ruin>) {
	const visibility = state.snapshot?.visibility;
	if (!visibility) return;
	const mapSize = state.snapshot!.map.size;
	for (const [id, entity] of Object.entries(memory)) {
		if (!current[id] && isVisibleNow(visibility, entity.x, entity.y, entityWidth(entity), entityHeight(entity), mapSize)) delete memory[id];
	}
}

function isVisibleNow(visibility: ClientSnapshot["visibility"], x: number, y: number, width: number, height: number, mapSize: number) {
	const visible = visibility?.visibleSet;
	if (!visible) return false;
	for (let yy = Math.floor(y); yy < Math.ceil(y + height); yy += 1) {
		for (let xx = Math.floor(x); xx < Math.ceil(x + width); xx += 1) {
			if (visible.has(yy * mapSize + xx)) return true;
		}
	}
	return false;
}

function hitTest(x: number, y: number) {
	if (!state.snapshot) return null;
	const candidates = [
		...Object.values(state.snapshot.units),
		...Object.values(state.snapshot.buildings),
		...Object.values(state.snapshot.resources),
		...Object.values(state.snapshot.corpses),
	];
	return closestHit(x, y, candidates);
}

function hitTestForSelection(x: number, y: number) {
	if (!state.snapshot) return null;
	const unitHit = closestHit(x, y, Object.values(state.snapshot.units));
	if (unitHit) return unitHit;
	return hitTest(x, y);
}

function closestHit<T extends Unit | Building | ResourceNode | Corpse>(x: number, y: number, candidates: T[]) {
	let best = null;
	let bestDistance = Infinity;
	for (const entity of candidates) {
		const rect = renderedEntityRect(entity);
		const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
		if (!inside) continue;
		const d = Math.hypot((rect.cx - x) / rect.width, (rect.cy - y) / rect.height);
		if (d < bestDistance) {
			best = entity;
			bestDistance = d;
		}
	}
	return best;
}

function renderedEntityRect(entity: Unit | Building | ResourceNode | Corpse) {
	const bounds = spriteMetrics(entity.type);
	const scale = entityPixel(entity, view.camera.zoom || 1);
	const center = entity.kind === "building" || entity.kind === "resource" || entity.kind === "corpse"
		? isoToScreen(entity.x + (entityWidth(entity) - 1) / 2, entity.y + (entityHeight(entity) - 1) / 2, view.camera)
		: isoToScreen(entity.x + entityWidth(entity) / 2, entity.y + entityHeight(entity) / 2, view.camera);
	const visualWidth = bounds.width * scale;
	const visualHeight = bounds.height * scale;
	const left = Math.round(center.x - visualWidth / 2);
	const top = Math.round(center.y + (entityHeight(entity) * TILE_H * (view.camera.zoom || 1)) / 2 - visualHeight);
	const pad = hitPadding(entity);
	return {
		left: left - pad,
		right: left + visualWidth + pad,
		top: top - pad,
		bottom: top + visualHeight + pad,
		cx: left + visualWidth / 2,
		cy: top + visualHeight / 2,
		width: visualWidth,
		height: visualHeight,
	};
}

function entityWidth(entity: { size?: number; width?: number }) {
	return entity.width ?? entity.size ?? 1;
}

function entityHeight(entity: { size?: number; height?: number }) {
	return entity.height ?? entity.size ?? 1;
}

function hitPadding(entity: { kind: string }) {
	const zoom = view.camera.zoom || 1;
	if (entity.kind === "building") return 10 * zoom;
	if (entity.kind === "resource") return 8 * zoom;
	return 5 * zoom;
}

function worldPixel(zoom: number) {
	return SCALE * zoom;
}

function entityPixel(entity: Unit | Building | ResourceNode | Corpse, zoom: number) {
	return worldPixel(zoom);
}

function unitBehavior(unit: Unit) {
	return unitBehaviorFor(unit.type);
}

function unitTypeForShortcut(key: string): UnitType | null {
	for (const Unit of allUnitClasses()) {
		if (Unit.trainShortcut?.toLowerCase() === key) return Unit.type;
	}
	return null;
}

function cullSelection() {
	if (!state.snapshot) return;
	for (const id of [...state.selectedIds]) {
		if (!state.snapshot.units[id] && !state.snapshot.buildings[id] && !state.snapshot.resources[id] && !state.snapshot.corpses[id]) state.selectedIds.delete(id);
	}
}
