import { disableAdminMode as requestDisableAdminMode, emitNoise as requestEmitNoise, enableAdminAccess, enableFullMapVision as requestFullMapVision, enablePathDebug, enableSoundDebug as requestSoundDebug, enableZombieDebug as requestZombieDebug, getStatus, grantSoldiers as requestGrantSoldiers, join, leave, logClientMessage, reportPing, restartServer as requestRestartServer, sendCommand, setTimeOfDay as requestSetTimeOfDay, spawnZombieHorde, toggleTownCenterInvincible as requestTownCenterInvincible } from "./api.js";
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
import type { Building, BuildingType, CommandPayload, Corpse, EntityId, PlayerId, ResourceNode, ResourceType, Ruin, Snapshot, Unit, UnitType } from "../../src/shared/types.js";
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
const DEV_COMMAND_BUFFER_LENGTH = 40;

const canvas = document.getElementById("world") as HTMLCanvasElement | null;
const minimap = document.getElementById("minimap") as HTMLCanvasElement | null;
if (!canvas || !minimap) throw new Error("Missing canvas elements");
const renderer = new Renderer(canvas);
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
const ui = new UI(state, {
	setBuildMode(type) {
		view.buildMode = type;
	},
		train(buildingId: string, unitType: UnitType) {
			issue({ type: "train", buildingId, unitType }).then((result) => {
				if (result.ok) sfx.play("train_queue", { point: state.snapshot?.buildings[buildingId] });
				else sfx.play(errorMessage(result).includes("Population") ? "population_blocked" : "ui_error");
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
		ui.showToast("Full-map admin vision enabled.");
		return "Full-map admin vision enabled.";
	},
	async enableSoundDebug() {
		if (!state.playerId) return "No active player.";
		const result = await requestSoundDebug(state.playerId);
		if (!result.ok) return result.error || "Could not enable sound field overlay.";
		connectEvents();
		ui.showToast("Sound field overlay enabled.");
		return "Sound field overlay enabled.";
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
		ui.showToast("Zombie state overlay enabled.");
		return "Zombie state overlay enabled.";
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

document.getElementById("joinForm")?.addEventListener("submit", async (event) => {
	event.preventDefault();
	sfx.unlock();
	const nameInput = document.getElementById("nameInput") as HTMLInputElement | null;
	const colorInput = document.getElementById("colorInput") as HTMLInputElement | null;
	const name = nameInput?.value.trim() || "Player";
	const color = colorInput?.value || "";
	const result = await join(name, color);
	if (!result.ok) {
		ui.showToast(result.error || "Could not join.");
		return;
	}
	const notice = document.getElementById("joinNotice");
	if (notice) notice.textContent = "";
	state.playerId = result.playerId;
	localStorage.setItem("rtsPlayerId", result.playerId);
	enterGame();
});

document.getElementById("leaveButton")?.addEventListener("click", async () => {
	sfx.unlock();
	await leaveCurrentGame("You left the game.");
});
document.getElementById("muteButton")?.addEventListener("click", toggleMusicMute);

window.addEventListener("resize", () => renderer.resize());
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
drawLoop();
initMusic();
updateHomeStatus();
setInterval(updateHomeStatus, 5000);
if (state.playerId) enterGame();

function enterGame() {
	document.getElementById("join")!.classList.add("hidden");
	document.getElementById("game")?.classList.remove("hidden");
	startMusic();
	connectEvents();
}

async function updateHomeStatus() {
	const onlinePlayers = document.getElementById("onlinePlayers");
	const resetStatus = document.getElementById("resetStatus");
	const lastUpdateDate = document.getElementById("lastUpdateDate");
	const lastUpdateTime = document.getElementById("lastUpdateTime");
	if (!onlinePlayers && !resetStatus && !lastUpdateDate && !lastUpdateTime) return;
	try {
		const status = await getStatus();
		if (onlinePlayers) onlinePlayers.textContent = `Players online: ${status.activePlayers}/${status.maxPlayers}`;
		if (resetStatus) resetStatus.textContent = formatResetStatus(status);
		const updatedAt = status.lastUpdate ? new Date(status.lastUpdate) : null;
		if (lastUpdateDate) lastUpdateDate.textContent = updatedAt ? updatedAt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "--";
		if (lastUpdateTime) lastUpdateTime.textContent = updatedAt ? updatedAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : "--";
	} catch {
		if (onlinePlayers) onlinePlayers.textContent = "Players online: --";
		if (resetStatus) resetStatus.textContent = "--";
		if (lastUpdateDate) lastUpdateDate.textContent = "--";
		if (lastUpdateTime) lastUpdateTime.textContent = "--";
	}
}

function formatResetStatus(status: Awaited<ReturnType<typeof getStatus>>) {
	if (status.reset.state === "active") return "Resets when 0 players remain";
	if (status.reset.state === "cold") return "Map reset. New map on join";
	const remainingMs = Math.max(0, status.reset.resetAt! - Date.now());
	return `Resetting in ${formatDuration(remainingMs)}`;
}

function formatDuration(ms: number) {
	const totalSeconds = Math.ceil(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes <= 0) return `${seconds}s`;
	return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
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

function updateMuteButton() {
	const button = document.getElementById("muteButton");
	if (!button) return;
	button.textContent = "";
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
	if (adminAccessEnabled || godModeCheckPending || !state.playerId || devCommandInput.length < 3) return;
	const checkedInput = devCommandInput;
	godModeCheckPending = true;
	try {
		const result = await enableAdminAccess(state.playerId, checkedInput);
		if (result.ok) {
			adminAccessEnabled = true;
			ui.showToast("Admin dashboard unlocked.");
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
	eventStream = new EventSource(`/events?playerId=${encodeURIComponent(state.playerId)}`);
	eventStream.onmessage = (event) => {
		const snap = hydrateSnapshot(JSON.parse(event.data) as Snapshot);
		if (!state.playerId || !snap.players?.[state.playerId] || snap.players[state.playerId]!.defeated) {
			handleEliminated();
			return;
		}
		applyVisibility(snap);
		state.snapshot = snap;
		adminDiagnosticsVisible = snap.admin !== null;
		if (adminDiagnosticsVisible) maybeReportPing(Math.max(0, Date.now() - snap.now));
		rememberStaticObjects();
		cullSelection();
		ui.render();
		sfx.observe(snap);
		centerOnTownOnce();
	};
	eventStream.onerror = () => ui.showToast("Connection interrupted.");
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
	localStorage.removeItem("rtsPlayerId");
	state.playerId = null;
	state.snapshot = null;
	adminDiagnosticsVisible = false;
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
	view.mouse = { x: event.clientX, y: event.clientY };
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
	const margin = 28;
	const speed = 10;
	if (view.mouse.x <= margin) view.camera.x += speed;
	if (view.mouse.x >= window.innerWidth - margin) view.camera.x -= speed;
	if (view.mouse.y <= margin) view.camera.y += speed;
	if (view.mouse.y >= window.innerHeight - margin) view.camera.y -= speed;
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
