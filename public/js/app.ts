import { banPlayer as requestBanPlayer, disableAdminMode as requestDisableAdminMode, emitNoise as requestEmitNoise, enableAdminAccess, enableFullMapVision as requestFullMapVision, enablePathDebug, enableSoundDebug as requestSoundDebug, enableZombieDebug as requestZombieDebug, grantResources as requestGrantResources, grantSoldiers as requestGrantSoldiers, kickPlayer as requestKickPlayer, leave, logClientMessage, reportPing, restartServer as requestRestartServer, sendCommand, setTimeOfDay as requestSetTimeOfDay, spawnZombieHorde, togglePathAvailabilityDebug as requestPathAvailabilityDebug, toggleTownCenterInvincible as requestTownCenterInvincible, toggleUnitTileDebug as requestUnitTileDebug, unbanIp as requestUnbanIp } from "./api.js";
import { Renderer } from "./render.js";
import { screenToIso, isoToScreen } from "./iso.js";
import { CameraDragPan } from "./cameraDragPan.js";
import { CameraEdgeScroll } from "./cameraEdgeScroll.js";
import { CameraPanThrow } from "./cameraPanThrow.js";
import { SoundEffects, buildingCommandSound, commandSoundForTarget } from "./sfx.js";
import { UI } from "./ui.js";
import { TRAINING } from "./constants.js";
import { Logs } from "../../src/shared/logs.js";
import { MusicPlayer } from "./musicPlayer.js";
import { SettingsController } from "./settingsController.js";
import { ActionHotkeys } from "./actionHotkeys.js";
import { ActionHotkeySettings } from "./actionHotkeySettings.js";
import { SnapshotStore } from "./snapshotStore.js";
import { SnapshotPreview } from "./snapshotPreview.js";
import { GlobalLeaderboardModal } from "./globalLeaderboardModal.js";
import { HomeScreen } from "./homeScreen.js";
import { pendingPrivateRoomId, PrivateClientGameSession, PrivateHostGameSession, PublicGameSession, PublicSpectatorGameSession, type GameSession } from "./gameSession.js";
import { SelectionController } from "./selectionController.js";
import { BuildPlacement } from "./buildPlacement.js";
import { TutorialController } from "./tutorial/tutorialController.js";
import type { Building, BuildingType, CommandPayload, Corpse, EntityId, ResourceNode, ResourceType, SnapshotMessage, Unit, UnitType } from "../../src/shared/types.js";
import type { SessionCredentials } from "./api.js";
import type { ClientCommand, GameState, ViewState } from "./clientTypes.js";

const state: GameState = {
	playerId: null,
	sessionToken: null,
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
	void logClientMessage(currentCredentials(), entry.message);
});

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
const cameraDragPan = new CameraDragPan();
const cameraEdgeScroll = new CameraEdgeScroll();
const cameraPanThrow = new CameraPanThrow();
const music = new MusicPlayer(sfx);
const snapshots = new SnapshotStore(state);
const snapshotPreview = new SnapshotPreview(snapshots);
const globalLeaderboard = new GlobalLeaderboardModal(snapshotPreview);
const selection = new SelectionController(state, view, sfx);
const buildPlacement = new BuildPlacement(state, view);
const tutorial = new TutorialController(
	document.getElementById("tutorialPanel")!,
	document.getElementById("tutorialList")!,
	document.getElementById("tutorialSkipButton") as HTMLButtonElement,
	document.getElementById("tutorialCollapseButton") as HTMLButtonElement,
	document.getElementById("tutorialContent")!,
);
const actionHotkeys = new ActionHotkeys();
const actionHotkeySettings = new ActionHotkeySettings(actionHotkeys);
const settings = new SettingsController(music, sfx, cameraDragPan, cameraEdgeScroll, cameraPanThrow, () => tutorial.restart(), actionHotkeySettings);

const ZOOM_STEPS = [0.2, 0.3, 0.4, 0.55, 0.75, 1, 1.25, 1.5, 1.75, 2];
const DEV_COMMAND_BUFFER_LENGTH = 40;

const canvas = document.getElementById("world") as HTMLCanvasElement | null;
const minimap = document.getElementById("minimap") as HTMLCanvasElement | null;
if (!canvas || !minimap) throw new Error("Missing canvas elements");
const renderer = new Renderer(canvas, { minimap, sizeMode: "viewport" });
let eventStream: EventSource | null = null;
let activeSession: GameSession | null = null;
let activePrivateInviteUrl: string | null = null;
let homeAdminInput = "";
let homeAdminSecret: string | null = null;
let devCommandInput = "";
let adminAccessEnabled = false;
let godModeCheckPending = false;
let pathDebugEnabled = false;
let zombieHordePending = false;
let lastFrameAt = performance.now();
let smoothedFps = 60;
let lastPingReportAt = 0;
let adminDiagnosticsVisible = false;
let adminView: "closed" | "popup" | "overview" | "performance" | "performancePaused" | "players" | "logs" | "devCommands" | "bans" = "closed";
const ui = new UI(state, {
	setBuildMode(type) {
		view.buildMode = type;
	},
	selectIdleWorkers: () => {
		selection.selectIdleWorkers();
		ui.render();
	},
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
		const credentials = currentCredentials();
		if (!credentials) return;
		await leave(credentials);
		window.location.reload();
	},
	async exitToMenu() {
		const credentials = currentCredentials();
		try {
			if (credentials) await leave(credentials);
		} finally {
			resetToJoin("");
		}
	},
	async disableAdminMode() {
		const credentials = currentCredentials();
		if (!credentials) return "No active player.";
		if (activeSession?.disableAdminMode) {
			const result = await activeSession.disableAdminMode();
			if (!result.ok) return result.error || "Could not disable admin mode.";
			state.exploredSet.clear();
			view.noiseMode = false;
			adminDiagnosticsVisible = false;
			pathDebugEnabled = false;
			connectEvents();
			ui.showToast("Admin mode disabled.");
			ui.render();
			return "Admin mode disabled.";
		}
		const result = await requestDisableAdminMode(credentials);
		if (!result.ok) return result.error || "Could not disable admin mode.";
			state.exploredSet.clear();
			view.noiseMode = false;
			adminDiagnosticsVisible = false;
			pathDebugEnabled = false;
			connectEvents();
		ui.showToast("Admin mode disabled.");
		ui.render();
		return "Admin mode disabled.";
	},
	async enableFullMapVision() {
		const credentials = currentCredentials();
		if (!credentials) return "No active player.";
		if (activeSession?.enableFullMapVision) {
			const result = await activeSession.enableFullMapVision();
			if (!result.ok) return result.error || "Could not enable full-map admin vision.";
			state.exploredSet.clear();
			connectEvents();
			const message = result.enabled ? "Full-map admin vision enabled." : "Full-map admin vision disabled.";
			ui.showToast(message);
			return message;
		}
		const result = await requestFullMapVision(credentials);
		if (!result.ok) return result.error || "Could not enable full-map admin vision.";
		state.exploredSet.clear();
		connectEvents();
		const message = result.enabled ? "Full-map admin vision enabled." : "Full-map admin vision disabled.";
		ui.showToast(message);
		return message;
	},
	async enableSoundDebug() {
		const credentials = currentCredentials();
		if (!credentials) return "No active player.";
		if (activeSession?.enableSoundDebug) {
			const result = await activeSession.enableSoundDebug();
			if (!result.ok) return result.error || "Could not enable sound field overlay.";
			connectEvents();
			const message = result.enabled ? "Sound field overlay enabled." : "Sound field overlay disabled.";
			ui.showToast(message);
			return message;
		}
		const result = await requestSoundDebug(credentials);
		if (!result.ok) return result.error || "Could not enable sound field overlay.";
		connectEvents();
		const message = result.enabled ? "Sound field overlay enabled." : "Sound field overlay disabled.";
		ui.showToast(message);
		return message;
	},
	async setTimeOfDay(progress, label) {
		const credentials = currentCredentials();
		if (!credentials) return "No active player.";
		snapshots.previewTimeOfDay(progress);
		let message = `Set time to ${label}.`;
		if (activeSession?.setTimeOfDay) {
			const result = await activeSession.setTimeOfDay(progress);
			if (result.ok) snapshots.clearTimeOffset();
			else message = `${message} (client preview only: ${result.error || "private host rejected it"})`;
			ui.showToast(message);
			ui.render();
			return message;
		}
		try {
			const result = await requestSetTimeOfDay(credentials, progress);
			if (result.ok) snapshots.clearTimeOffset();
			else message = `${message} (client preview only: ${result.error || "server rejected it"})`;
		} catch {
			message = `${message} (client preview only: server unavailable)`;
		}
		ui.showToast(message);
		ui.render();
		return message;
	},
	async enableZombieDebug() {
		const credentials = currentCredentials();
		if (!credentials) return "No active player.";
		if (activeSession?.enableZombieDebug) {
			const result = await activeSession.enableZombieDebug();
			if (!result.ok) return result.error || "Could not enable zombie state overlay.";
			connectEvents();
			const message = result.enabled ? "Zombie state overlay enabled." : "Zombie state overlay disabled.";
			ui.showToast(message);
			return message;
		}
		const result = await requestZombieDebug(credentials);
		if (!result.ok) return result.error || "Could not enable zombie state overlay.";
		connectEvents();
		const message = result.enabled ? "Zombie state overlay enabled." : "Zombie state overlay disabled.";
		ui.showToast(message);
		return message;
	},
	async togglePathDebug() {
		const credentials = currentCredentials();
		if (!credentials) return "No active player.";
		if (activeSession?.togglePathDebug) {
			const result = await activeSession.togglePathDebug();
			if (!result.ok) return result.error || "Could not toggle path lines.";
			pathDebugEnabled = result.enabled === true;
			connectEvents();
			const message = result.enabled ? "Path lines enabled." : "Path lines disabled.";
			ui.showToast(message);
			return message;
		}
		const result = await enablePathDebug(credentials);
		if (!result.ok) return result.error || "Could not toggle path lines.";
		pathDebugEnabled = result.enabled === true;
		connectEvents();
		const message = result.enabled ? "Path lines enabled." : "Path lines disabled.";
		ui.showToast(message);
		return message;
	},
	async togglePathAvailabilityDebug() {
		const credentials = currentCredentials();
		if (!credentials) return "No active player.";
		if (activeSession?.togglePathAvailabilityDebug) {
			const result = await activeSession.togglePathAvailabilityDebug();
			if (!result.ok) return result.error || "Could not toggle blocked path tiles.";
			connectEvents();
			const message = result.enabled ? "Blocked path tiles enabled." : "Blocked path tiles disabled.";
			ui.showToast(message);
			return message;
		}
		const result = await requestPathAvailabilityDebug(credentials);
		if (!result.ok) return result.error || "Could not toggle blocked path tiles.";
		connectEvents();
		const message = result.enabled ? "Blocked path tiles enabled." : "Blocked path tiles disabled.";
		ui.showToast(message);
		return message;
	},
	async toggleUnitTileDebug() {
		const credentials = currentCredentials();
		if (!credentials) return "No active player.";
		if (activeSession?.toggleUnitTileDebug) {
			const result = await activeSession.toggleUnitTileDebug();
			if (!result.ok) return result.error || "Could not toggle unit tiles.";
			connectEvents();
			const message = result.enabled ? "Unit tiles enabled." : "Unit tiles disabled.";
			ui.showToast(message);
			return message;
		}
		const result = await requestUnitTileDebug(credentials);
		if (!result.ok) return result.error || "Could not toggle unit tiles.";
		connectEvents();
		const message = result.enabled ? "Unit tiles enabled." : "Unit tiles disabled.";
		ui.showToast(message);
		return message;
	},
	async kickPlayer(targetPlayerId) {
		if (activeSession?.mode !== "public") return "Player moderation is hidden for private games for now.";
		const credentials = currentCredentials();
		if (!credentials) return "No active player.";
		const result = await requestKickPlayer(credentials, targetPlayerId);
		if (!result.ok) return result.error || "Could not kick player.";
		return "Player kicked.";
	},
	async banPlayer(targetPlayerId) {
		if (activeSession?.mode !== "public") return "Player moderation is hidden for private games for now.";
		const credentials = currentCredentials();
		if (!credentials) return "No active player.";
		const result = await requestBanPlayer(credentials, targetPlayerId);
		if (!result.ok) return result.error || "Could not ban player.";
		return `Banned ${result.ipAddress ?? "player IP"}.`;
	},
	async unbanIp(ipAddress) {
		if (activeSession?.mode !== "public") return "IP bans are hidden for private games for now.";
		const credentials = currentCredentials();
		if (!credentials) return "No active player.";
		const result = await requestUnbanIp(credentials, ipAddress);
		if (!result.ok) return result.error || "Could not unban IP.";
		return "IP unbanned.";
	},
	async spawnHostileHorde() {
		const credentials = currentCredentials();
		if (!credentials) return "No active player.";
		if (activeSession?.spawnZombieHorde) {
			const result = await activeSession.spawnZombieHorde(500);
			if (!result.ok) return result.error || "Could not spawn hostile horde.";
			ui.showToast(`Spawned ${result.spawned ?? 500} hostile units.`);
			return `Spawned ${result.spawned ?? 500} hostile units.`;
		}
		const result = await spawnZombieHorde(credentials, 500);
		if (!result.ok) return result.error || "Could not spawn hostile horde.";
		ui.showToast(`Spawned ${result.spawned ?? 500} hostile units.`);
		return `Spawned ${result.spawned ?? 500} hostile units.`;
	},
	async grantSoldiers() {
		const credentials = currentCredentials();
		if (!credentials) return "No active player.";
		if (activeSession?.grantSoldiers) {
			const result = await activeSession.grantSoldiers(100);
			if (!result.ok) return result.error || "Could not grant soldiers.";
			ui.showToast(`Granted ${result.granted ?? 100} soldiers.`);
			return `Granted ${result.granted ?? 100} soldiers.`;
		}
		const result = await requestGrantSoldiers(credentials, 100);
		if (!result.ok) return result.error || "Could not grant soldiers.";
		ui.showToast(`Granted ${result.granted ?? 100} soldiers.`);
		return `Granted ${result.granted ?? 100} soldiers.`;
	},
	async grantResources(resource: ResourceType | "stone") {
		const credentials = currentCredentials();
		if (!credentials) return "No active player.";
		if (activeSession?.grantResources) {
			const normalized = resource === "stone" ? "ore" : resource;
			const result = await activeSession.grantResources(normalized, 1000);
			if (!result.ok) return result.error || "Could not grant resources.";
			const label = resource === "stone" ? "stone" : resource;
			ui.showToast(`Granted 1000 ${label}.`);
			return `Granted 1000 ${label}.`;
		}
		const result = await requestGrantResources(credentials, resource, 1000);
		if (!result.ok) return result.error || "Could not grant resources.";
		const label = resource === "stone" ? "stone" : resource;
		ui.showToast(`Granted 1000 ${label}.`);
		return `Granted 1000 ${label}.`;
	},
	async toggleTownCenterInvincible() {
		const credentials = currentCredentials();
		if (!credentials) return "No active player.";
		if (activeSession?.toggleTownCenterInvincible) {
			const result = await activeSession.toggleTownCenterInvincible();
			if (!result.ok) return result.error || "Could not toggle town center invincibility.";
			const message = result.invincible ? "Town center is now invincible." : "Town center invincibility disabled.";
			ui.showToast(message);
			return message;
		}
		const result = await requestTownCenterInvincible(credentials);
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
		if (activeSession?.mode !== "public") return "Restart server is hidden for private games for now.";
		const credentials = currentCredentials();
		if (!credentials) return "No active player.";
		const result = await requestRestartServer(credentials);
		if (!result.ok) return result.error || "Could not restart server.";
		resetToJoin("Server restarted. Join again to start a fresh map.");
		return "Server restarted.";
	},
}, actionHotkeys);

const home = new HomeScreen(
	(request) => {
		void startSession(request);
	},
	() => sfx.unlock(),
	(message) => ui.showToast(message),
	pendingPrivateRoomId(),
);
home.renderStaticContent();
home.wireDom();
globalLeaderboard.wireDom();
snapshotPreview.wireDom();

document.getElementById("leaveButton")?.addEventListener("click", async () => {
	sfx.unlock();
	await leaveCurrentGame("You left the game.");
	void home.updateStatus({ force: true });
});
document.getElementById("privateInviteButton")?.addEventListener("click", () => {
	if (!activePrivateInviteUrl) return;
	void copyPrivateInvite();
});
settings.wireDom();
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
	const credentials = currentCredentials();
	if (credentials) void activeSession?.leave(credentials);
});

canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener("selectstart", (event) => event.preventDefault());
canvas.addEventListener("dragstart", (event) => event.preventDefault());
canvas.addEventListener("mousedown", onMouseDown);
canvas.addEventListener("mousemove", onMouseMove);
canvas.addEventListener("mouseup", onMouseUp);
document.addEventListener("mousemove", onPointerLockedPanMove);
document.addEventListener("mouseup", onPointerLockedPanUp);
document.addEventListener("pointerlockchange", onPointerLockChange);
canvas.addEventListener("wheel", (event) => {
	event.preventDefault();
	cameraPanThrow.stop();
	const before = screenToIso(event.clientX, event.clientY, view.camera);
	view.camera.zoom = nextZoom(view.camera.zoom!, event.deltaY < 0 ? 1 : -1);
	const after = isoToScreen(before.x, before.y, view.camera);
	view.camera.x += event.clientX - after.x;
	view.camera.y += event.clientY - after.y;
	clampCamera();
});
window.addEventListener("keydown", onKeyDown);
window.addEventListener("keydown", onDevShortcutKeyDown);
window.addEventListener("keydown", onHomeAdminKeyDown);
minimap.addEventListener("mousedown", (event) => moveCameraFromMinimap(event));
minimap.addEventListener("mousemove", (event) => {
	if (event.buttons === 1) moveCameraFromMinimap(event);
});
minimap.addEventListener("contextmenu", (event) => event.preventDefault());
minimap.addEventListener("mousedown", onMinimapMouseDown);

renderer.resize();
settings.init();
drawLoop();
void music.init();
void home.updateStatus();
setInterval(() => void home.updateStatus(), 2000);
setInterval(() => home.renderStatus(), 1000);

function currentCredentials(): SessionCredentials | null {
	if (!state.playerId || !state.sessionToken) return null;
	return { playerId: state.playerId, sessionToken: state.sessionToken };
}

async function copyPrivateInvite() {
	if (!activePrivateInviteUrl) return;
	if (await writeClipboard(activePrivateInviteUrl)) {
		ui.showToast("Private invite link copied.");
		return;
	}
	window.prompt("Copy private invite link:", activePrivateInviteUrl);
}

async function writeClipboard(text: string) {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// Plain HTTP LAN pages often cannot use the async clipboard API.
	}
	const input = document.createElement("textarea");
	input.value = text;
	input.setAttribute("readonly", "true");
	input.style.position = "fixed";
	input.style.left = "-9999px";
	document.body.append(input);
	input.select();
	try {
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		input.remove();
	}
}

function showPrivateInviteButton(visible: boolean) {
	const button = document.getElementById("privateInviteButton");
	if (!button) return;
	button.classList.toggle("hidden", !visible);
}

function enterGame() {
	document.getElementById("join")!.classList.add("hidden");
	document.getElementById("game")?.classList.remove("hidden");
	document.getElementById("game")?.classList.remove("dead");
	renderer.resize();
	music.start();
	connectEvents();
	tutorial.start();
}

async function startSession(request: { name: string; color: string; mode: "public" | "private" }) {
	activeSession?.dispose();
	const privateRoomId = pendingPrivateRoomId();
	const session: GameSession = request.mode === "public"
		? new PublicGameSession()
		: privateRoomId
			? new PrivateClientGameSession(privateRoomId)
			: new PrivateHostGameSession();
	activeSession = session;
	const joined = await session.join({ name: request.name, color: request.color });
	if (!joined.ok) {
		home.setJoining(false);
		const notice = document.getElementById("joinNotice");
		if (notice) {
			notice.textContent = joined.error;
			notice.classList.remove("hidden");
		}
		ui.showToast(joined.error);
		return;
	}
	state.playerId = joined.result.playerId;
	state.sessionToken = joined.result.sessionToken;
	if (joined.result.inviteUrl) {
		activePrivateInviteUrl = joined.result.inviteUrl;
		showPrivateInviteButton(true);
		void copyPrivateInvite();
	} else {
		activePrivateInviteUrl = null;
		showPrivateInviteButton(false);
	}
	enterGame();
}

function onDevShortcutKeyDown(event: KeyboardEvent) {
	if (!currentCredentials() || isDead()) return;
	if (event.key.length !== 1) return;
	devCommandInput = `${devCommandInput}${event.key}`.slice(-DEV_COMMAND_BUFFER_LENGTH);
	void maybeEnableAdminAccess();
	void maybeEnablePathDebug();
	void maybeSpawnZombieHorde();
}

function onHomeAdminKeyDown(event: KeyboardEvent) {
	if (document.getElementById("join")?.classList.contains("hidden")) return;
	if (event.key.length !== 1) return;
	homeAdminInput = `${homeAdminInput}${event.key}`.slice(-DEV_COMMAND_BUFFER_LENGTH);
	void maybeOpenHomeAdmin(homeAdminInput);
}

async function maybeOpenHomeAdmin(secret: string) {
	const overview = await fetchAdminOverview(secret);
	if (!overview.ok) return;
	homeAdminSecret = secret;
	renderHomeAdmin(overview);
}

async function fetchAdminOverview(secret: string): Promise<AdminOverviewResult> {
	try {
		const res = await fetch("/api/admin-overview", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ secret }),
		});
		return await res.json() as AdminOverviewResult;
	} catch {
		return { ok: false, error: "Could not load admin overview." };
	}
}

function renderHomeAdmin(overview: Extract<AdminOverviewResult, { ok: true }>) {
	const panel = ensureHomeAdminPanel();
	const publicGame = overview.publicGame.active
		? `<tr><td>Public</td><td>${overview.publicGame.players} players</td><td>${formatMs(overview.publicGame.ageMs ?? 0)}</td><td>${overview.publicGame.tps.toFixed(1)}</td><td><button type="button" data-spectate-public="true">Spectate</button></td></tr>`
		: `<tr><td>Public</td><td colspan="3">No active public game</td><td></td></tr>`;
	const privateRows = overview.privateGames.length
		? overview.privateGames.map((game) => `<tr><td>${game.roomId}</td><td>${game.playerCount} players · ${game.pendingJoins} pending</td><td>${formatMs(game.ageMs)}</td><td>${formatMs(Date.now() - game.lastHostSeenAt)} ago</td><td></td></tr>`).join("")
		: `<tr><td colspan="5">No private rooms are currently registered.</td></tr>`;
	panel.innerHTML = `
		<div class="home-admin-dialog">
			<header>
				<h2>Admin Overview</h2>
				<button type="button" data-home-admin-close="true">X</button>
			</header>
			<h3>Public Game</h3>
			<table><tbody>${publicGame}</tbody></table>
			<h3>Private Games</h3>
			<table>
				<thead><tr><th>Invite</th><th>Players</th><th>Age</th><th>Host Seen</th><th></th></tr></thead>
				<tbody>${privateRows}</tbody>
			</table>
		</div>
	`;
	panel.classList.remove("hidden");
	panel.querySelector("[data-home-admin-close]")?.addEventListener("click", () => panel.classList.add("hidden"));
	panel.querySelector("[data-spectate-public]")?.addEventListener("click", () => void startSpectating("public"));
}

function ensureHomeAdminPanel() {
	let panel = document.getElementById("homeAdminPanel");
	if (panel) return panel;
	panel = document.createElement("section");
	panel.id = "homeAdminPanel";
	panel.className = "home-admin-panel hidden";
	document.body.append(panel);
	return panel;
}

async function startSpectating(kind: "public") {
	if (!homeAdminSecret) return;
	document.getElementById("homeAdminPanel")?.classList.add("hidden");
	activeSession?.dispose();
	const session: GameSession = new PublicSpectatorGameSession(homeAdminSecret);
	activeSession = session;
	const joined = await session.join({ name: "Admin Spectator", color: "#ffffff" });
	if (!joined.ok) {
		ui.showToast(joined.error);
		return;
	}
	state.playerId = joined.result.playerId;
	state.sessionToken = joined.result.sessionToken;
	enterGame();
}

function formatMs(ms: number) {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	if (hours) return `${hours}h ${minutes % 60}m`;
	if (minutes) return `${minutes}m`;
	return `${seconds}s`;
}

type AdminOverviewResult =
	| { ok: false; error?: string }
	| {
		ok: true;
		publicGame:
			| { active: false }
			| { active: true; players: number; startedAt: number | null; ageMs: number | null; tps: number; tickMs: number; tick: number };
		privateGames: Array<{
			roomId: string;
			createdAt: number;
			ageMs: number;
			lastHostSeenAt: number;
			playerCount: number;
			pendingJoins: number;
		}>;
	};

async function maybeEnableAdminAccess() {
	const credentials = currentCredentials();
	if (godModeCheckPending || !credentials || devCommandInput.length < 3) return;
	const checkedInput = devCommandInput;
	godModeCheckPending = true;
	try {
		if (activeSession?.enableAdminAccess) {
			const result = await activeSession.enableAdminAccess(checkedInput);
			if (result.ok) {
				adminAccessEnabled = result.enabled !== false;
				adminView = adminAccessEnabled ? "popup" : "closed";
				ui.showToast(adminAccessEnabled ? "Admin dashboard unlocked." : "Admin mode disabled.");
				connectEvents();
			}
			return;
		}
		const result = await enableAdminAccess(credentials, checkedInput);
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
	const credentials = currentCredentials();
	if (!adminAccessEnabled || pathDebugEnabled || !credentials || !devCommandInput.endsWith("revealpathfinding")) return;
	try {
		if (activeSession?.togglePathDebug) {
			const result = await activeSession.togglePathDebug();
			if (result.ok) {
				pathDebugEnabled = result.enabled === true;
				ui.showToast("Pathfinding debug enabled.");
				connectEvents();
			}
			return;
		}
		const result = await enablePathDebug(credentials);
		if (result.ok) {
			pathDebugEnabled = true;
			ui.showToast("Pathfinding debug enabled.");
			connectEvents();
		}
	} catch {
		// Keep this shortcut silent unless it succeeds.
	}
}

async function maybeSpawnZombieHorde() {
	const credentials = currentCredentials();
	if (!adminAccessEnabled || zombieHordePending || !credentials || !devCommandInput.endsWith("zombiehorde")) return;
	zombieHordePending = true;
	try {
		if (activeSession?.spawnZombieHorde) {
			const result = await activeSession.spawnZombieHorde(500);
			if (result.ok) ui.showToast(`Spawned ${result.spawned ?? 500} zombies.`);
			return;
		}
		const result = await spawnZombieHorde(credentials, 500);
		if (result.ok) ui.showToast(`Spawned ${result.spawned ?? 500} zombies.`);
	} catch {
		// Keep this shortcut silent unless it succeeds.
	} finally {
		zombieHordePending = false;
	}
}

function connectEvents() {
	if (eventStream) eventStream.close();
	const credentials = currentCredentials();
	if (!credentials || !activeSession) return;
	if ("setAdminView" in activeSession && typeof activeSession.setAdminView === "function") activeSession.setAdminView(adminView);
	activeSession.connect((message) => {
		const snap = snapshots.fromMessage(message);
		if (!snap) {
			connectEvents();
			return;
		}
		if (!isSpectating() && (!state.playerId || !snap.players?.[state.playerId])) {
			resetToJoin("Your player is no longer available. Join again to restart.");
			return;
		}
		snapshots.applyVisibility(snap);
		state.snapshot = snap;
		if (state.playerId != null && snap.players[state.playerId]!.defeated) {
			handleEliminated();
			return;
		}
		adminDiagnosticsVisible = snap.admin !== null;
		if (snap.admin !== null) adminAccessEnabled = true;
		if (adminDiagnosticsVisible) maybeReportPing(Math.max(0, Date.now() - snap.now));
		selection.rememberStaticObjects();
		selection.cullSelection();
		ui.render();
		sfx.observe(snap);
		centerOnTownOnce();
	}, (message) => ui.showToast(message));
}

function maybeReportPing(pingMs: number) {
	const credentials = currentCredentials();
	if (!credentials || Date.now() - lastPingReportAt < 2000) return;
	lastPingReportAt = Date.now();
	void reportPing(credentials, pingMs);
}

async function leaveCurrentGame(message: string) {
	const credentials = currentCredentials();
	if (!credentials || !state.snapshot) {
		resetToJoin(message);
		return;
	}
	if (eventStream) eventStream.close();
	eventStream = null;
	const result = await leave(credentials);
	if (!result.ok || !result.statistics) {
		resetToJoin(result.error || message);
		return;
	}
	state.snapshot = { ...state.snapshot, statistics: result.statistics };
	handleEliminated();
}

function handleEliminated() {
	activeSession?.dispose();
	if (eventStream) eventStream.close();
	eventStream = null;
	state.selectedIds.clear();
	view.buildMode = null;
	view.rallyModeBuildingId = null;
	document.getElementById("game")?.classList.add("dead");
	ui.render();
	sfx.reset();
}

function resetToJoin(message: string) {
	activeSession?.dispose();
	if (eventStream) eventStream.close();
	eventStream = null;
	activeSession = null;
	activePrivateInviteUrl = null;
	showPrivateInviteButton(false);
	snapshots.resetSequence();
	state.playerId = null;
	state.sessionToken = null;
	state.snapshot = null;
	adminDiagnosticsVisible = false;
	adminAccessEnabled = false;
	adminView = "closed";
	state.selectedIds.clear();
	state.effects = [];
	sfx.reset();
	centered = false;
	document.getElementById("game")?.classList.add("hidden");
	document.getElementById("game")?.classList.remove("dead");
	document.getElementById("join")?.classList.remove("hidden");
	home.setJoining(false);
	const notice = document.getElementById("joinNotice");
	if (notice) notice.textContent = message || "";
	if (message) ui.showToast(message);
}

function isAdminView(value: string): value is typeof adminView {
	return value === "closed" || value === "popup" || value === "overview" || value === "performance" || value === "performancePaused" || value === "players" || value === "logs" || value === "devCommands" || value === "bans";
}

let centered = false;
function centerOnTownOnce() {
	if (centered || !state.snapshot) return;
	centerOnTown(true);
}

function centerOnTown(once = true) {
	if (!state.snapshot) return;
	if (once && centered) return;
	const town = Object.values(state.snapshot.buildings).find((building) => (
		building.type === "townCenter" &&
		(isSpectating() || building.ownerId === state.playerId)
	));
	if (!town) return;
	const screen = isoToScreen(town.x + (town.size - 1) / 2, town.y + (town.size - 1) / 2, { x: 0, y: 0, zoom: view.camera.zoom });
	view.camera.x = window.innerWidth / 2 - screen.x;
	view.camera.y = window.innerHeight / 2 - screen.y;
	clampCamera();
	centered = true;
}

function isSpectating() {
	return activeSession?.mode === "public-spectator";
}

function drawLoop() {
	updateFpsStat();
	stepCameraPanThrow();
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

function stepCameraPanThrow() {
	const delta = cameraPanThrow.step();
	if (delta.x === 0 && delta.y === 0) return;
	view.camera.x += delta.x;
	view.camera.y += delta.y;
	clampCamera();
}

function onMouseDown(event: MouseEvent) {
	sfx.unlock();
	if (event.button === 1 || (event.shiftKey && event.button !== 0)) {
		if (!canvas) return;
		event.preventDefault();
		cameraDragPan.begin(canvas, event.clientX, event.clientY);
		cameraPanThrow.begin(event.clientX, event.clientY, event.timeStamp);
		view.panning = true;
		view.panLast = { x: event.clientX, y: event.clientY };
		return;
	}
	cameraPanThrow.stop();
	if (event.button === 2) return handleRightClick(event);
	view.dragging = true;
	view.dragStart = { x: event.clientX, y: event.clientY };
	view.dragCurrent = { x: event.clientX, y: event.clientY };
	view.wallDragStartTile = view.buildMode === "wall" && view.hoverTile ? { ...view.hoverTile } : null;
}

function onMouseMove(event: MouseEvent) {
	if (view.panning && document.pointerLockElement === canvas) return;
	view.hoverTile = visualTileFromScreen(event.clientX, event.clientY);
	if (view.panning) panCameraFromMouseMove(event);
	if (view.dragging) view.dragCurrent = { x: event.clientX, y: event.clientY };
}

function onPointerLockedPanMove(event: MouseEvent) {
	if (!view.panning || document.pointerLockElement !== canvas) return;
	panCameraFromMouseMove(event);
}

function onPointerLockedPanUp(event: MouseEvent) {
	if (!view.panning || document.pointerLockElement !== canvas) return;
	onMouseUp(event);
}

function panCameraFromMouseMove(event: MouseEvent) {
	const delta = cameraDragPan.move(event);
	cameraPanThrow.recordDelta(delta, event.timeStamp);
	view.camera.x += delta.x;
	view.camera.y += delta.y;
	clampCamera();
	view.panLast = { x: event.clientX, y: event.clientY };
}

function onPointerLockChange() {
	cameraDragPan.cancelPointerLockExit();
	if (view.panning && document.pointerLockElement !== canvas) {
		view.panning = false;
		cameraPanThrow.release();
	}
}

function trackMousePosition(event: MouseEvent) {
	view.mouse = { x: event.clientX, y: event.clientY };
}

function onMouseUp(event: MouseEvent) {
	if (view.panning) {
		view.panning = false;
		cameraDragPan.end();
		cameraPanThrow.release(event.timeStamp);
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
	if (dx < 5 && dy < 5) selection.selectAt(event.clientX, event.clientY, event.shiftKey);
		else selection.selectBox(event.shiftKey);
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
	const hit = selection.hitTest(event.clientX, event.clientY);
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
		const point = visualTileFromScreen(event.clientX, event.clientY);
		issue({ type: "move", unitIds: ownUnits, x: point.x, y: point.y }).then((result) => {
			if (result.ok) addMoveCross(point.x, point.y);
			sfx.play(result.ok ? "ui_command_move" : "ui_error", { point });
		});
	}
}

function visualTileFromScreen(x: number, y: number) {
	const iso = screenToIso(x, y, view.camera);
	return { x: Math.round(iso.x), y: Math.round(iso.y) };
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
	const credentials = currentCredentials();
	if (!credentials) return;
	const iso = screenToIso(x, y, view.camera);
	if (activeSession?.emitNoise) void activeSession.emitNoise(iso.x, iso.y);
	else void requestEmitNoise(credentials, iso.x, iso.y);
	addMoveCross(iso.x, iso.y);
}

function setRallyPointFromScreen(x: number, y: number, buildingId = view.rallyModeBuildingId) {
	if (!buildingId) return;
	const hit = selection.hitTest(x, y);
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
	if ((!view.instantBuildMode && !buildPlacement.canAffordBuildAt(mode as BuildingType, view.hoverTile.x, view.hoverTile.y)) || !buildPlacement.canPlacePreview(mode as BuildingType, view.hoverTile.x, view.hoverTile.y)) {
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
	const tiles = buildPlacement.wallLineTiles();
	if (!tiles.length || (!view.instantBuildMode && unitIds.length === 0)) return;
	if ((!view.instantBuildMode && !buildPlacement.canAffordLine("wall", tiles)) || tiles.some((tile) => !buildPlacement.canPlacePreview("wall", tile.x, tile.y))) {
		ui.showToast("Cannot place that wall there.");
		sfx.play("ui_error");
		return;
	}
	view.buildMode = null;
	view.wallDragStartTile = null;
	const command = {
		type: "buildWallLine" as const,
		unitIds,
		tiles,
		instant: view.instantBuildMode ? true : undefined,
	};
	const point = tiles[tiles.length - 1]!;
	const result = await issue(command);
	sfx.play(result.ok ? "ui_command_build" : "ui_error", { point, cooldownKey: "wall_line_build" });
}

async function issue(payload: ClientCommand, options: { silent?: boolean } = {}) {
	if (isDead()) return { ok: false, error: "Player unavailable." };
	const credentials = currentCredentials();
	if (!credentials || !activeSession) return { ok: false };
	const result = await activeSession.issue({ ...payload, playerId: credentials.playerId } as unknown as CommandPayload, credentials.sessionToken);
	if (result.ok) tutorial.handleEvent({ type: "commandSucceeded", command: payload });
	if (!result.ok && !options.silent) {
		ui.showToast(result.error || "Command failed.");
		sfx.play(result.error?.includes("Population") ? "population_blocked" : "ui_error");
	}
	return result;
}

function isDead() {
	return state.snapshot?.statistics !== null && state.snapshot?.statistics !== undefined;
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

function onKeyDown(event: KeyboardEvent) {
	sfx.unlock();
	if (!isDead() && actionHotkeys.handleKeyDown(event)) return;
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
	if (key === ".") {
		selection.selectIdleWorkers();
		ui.render();
		return;
	}
}

function deleteSelectedBuilding() {
	const building = [...state.selectedIds].map((id) => state.snapshot?.buildings[id]).find((entity) => entity?.ownerId === state.playerId);
	if (building) issue({ type: "deleteBuilding", buildingId: building.id }).then((result) => {
		sfx.play(result.ok ? "building_destroyed" : "ui_error", { point: building });
	});
}

function selectedProductionBuilding() {
	return [...state.selectedIds]
		.map((id) => state.snapshot?.buildings[id])
		.find((building) => building?.ownerId === state.playerId && ((TRAINING as Record<string, unknown[]>)[building.type] || []).length > 0);
}

function setZoom(zoom: number) {
	view.camera.zoom = zoom;
	clampCamera();
}

function edgePan() {
	const game = document.getElementById("game");
	if (!game || game.classList.contains("hidden")) return;
	if (cameraEdgeScroll.step(view.camera, view.mouse, { x: window.innerWidth, y: window.innerHeight })) clampCamera();
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
	cameraPanThrow.stop();
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
