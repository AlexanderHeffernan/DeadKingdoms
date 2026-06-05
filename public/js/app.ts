import { enableGodMode, enableSoundDebug, join, leave, sendCommand } from "./api.js";
import { Renderer } from "./render.js";
import { screenToIso, isoToScreen } from "./iso.js";
import { UI } from "./ui.js";
import { BUILDINGS, SCALE, TILE_H, TRAINING } from "./constants.js";
import { BUILDING_DEFS, deserializeBuilding } from "../../src/shared/buildingRegistry.js";
import { allUnitClasses, unitBehaviorFor } from "../../src/shared/unitRegistry.js";
import { sprites } from "./sprites/index.js";
import { spriteBounds } from "./spriteBounds.js";
import type { Building, BuildingType, CommandPayload, EntityId, PlayerId, ResourceNode, ResourceType, Ruin, Snapshot, Unit, UnitType } from "../../src/shared/types.js";
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
};

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
  hoverTile: null,
  mouse: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
};

const ZOOM_STEPS = [0.4, 0.55, 0.75, 1, 1.25, 1.5, 1.75, 2];
const DEV_COMMAND_BUFFER_LENGTH = 40;

const canvas = document.getElementById("world") as HTMLCanvasElement | null;
const minimap = document.getElementById("minimap") as HTMLCanvasElement | null;
if (!canvas || !minimap) throw new Error("Missing canvas elements");
const renderer = new Renderer(canvas);
let eventStream: EventSource | null = null;
let devCommandInput = "";
let godModeEnabled = false;
let godModeCheckPending = false;
let soundDebugEnabled = false;
let soundDebugCheckPending = false;
let lastFrameAt = performance.now();
let smoothedFps = 60;
const ui = new UI(state, {
  setBuildMode(type) {
    view.buildMode = type;
  },
  train(buildingId: string, unitType: UnitType) {
    issue({ type: "train", buildingId, unitType });
  },
  toggleAutoFarm() {
    issue({ type: "toggleAutoFarm" });
  },
  replenishFarm(farmId) {
    issue({ type: "replenishFarm", farmId });
  },
  deleteBuilding(buildingId) {
    issue({ type: "deleteBuilding", buildingId });
  },
  setRallyMode(buildingId) {
    view.rallyModeBuildingId = buildingId;
    ui.showToast("Choose a rally point.");
  },
  async respawn() {
    if (!state.playerId) return;
    await leave(state.playerId);
    localStorage.removeItem("rtsPlayerId");
    window.location.reload();
  },
});

document.getElementById("joinForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
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
  view.camera.x = Math.round(view.camera.x + event.clientX - after.x);
  view.camera.y = Math.round(view.camera.y + event.clientY - after.y);
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
if (state.playerId) enterGame();

function enterGame() {
  document.getElementById("join")!.classList.add("hidden");
  document.getElementById("game")?.classList.remove("hidden");
  startMusic();
  connectEvents();
}

async function initMusic() {
  music.audio.volume = 0.45;
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
  void maybeEnableGodMode();
  void maybeEnableSoundDebug();
}

async function maybeEnableGodMode() {
  if (godModeEnabled || godModeCheckPending || !state.playerId || devCommandInput.length < 3) return;
  const checkedInput = devCommandInput;
  godModeCheckPending = true;
  try {
    const result = await enableGodMode(state.playerId, checkedInput);
    if (result.ok) {
      godModeEnabled = true;
      state.exploredSet.clear();
      ui.showToast("God mode enabled: full map revealed.");
      connectEvents();
    }
  } catch {
    // Keep this shortcut silent unless it succeeds.
  } finally {
    godModeCheckPending = false;
    if (!godModeEnabled && checkedInput !== devCommandInput) void maybeEnableGodMode();
  }
}

async function maybeEnableSoundDebug() {
  if (soundDebugEnabled || soundDebugCheckPending || !state.playerId || devCommandInput.length < 3) return;
  const checkedInput = devCommandInput;
  soundDebugCheckPending = true;
  try {
    const result = await enableSoundDebug(state.playerId, checkedInput);
    if (result.ok) {
      soundDebugEnabled = true;
      ui.showToast("Sound debug enabled: sound ranges visible.");
      connectEvents();
    }
  } catch {
    // Keep this shortcut silent unless it succeeds.
  } finally {
    soundDebugCheckPending = false;
    if (!soundDebugEnabled && checkedInput !== devCommandInput) void maybeEnableSoundDebug();
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
    rememberStaticObjects();
    cullSelection();
    ui.render();
    centerOnTownOnce();
  };
  eventStream.onerror = () => ui.showToast("Connection interrupted.");
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
  state.selectedIds.clear();
  state.effects = [];
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
  return { ...snap, buildings };
}

let centered = false;
function centerOnTownOnce() {
  if (centered || !state.snapshot) return;
  centerOnTown(true);
}

function centerOnTown(once = true) {
  if (!state.snapshot) return;
  if (once && centered) return;
  const town = Object.values(state.snapshot.buildings).find((building) => building.ownerId === state.playerId && building.isTownCenter());
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
  const now = performance.now();
  const dt = Math.max(1, now - lastFrameAt);
  lastFrameAt = now;
  const fps = 1000 / dt;
  smoothedFps = smoothedFps * 0.9 + fps * 0.1;
  const el = document.getElementById("fps");
  if (el) el.textContent = `FPS ${Math.round(smoothedFps)}`;
}

function onMouseDown(event: MouseEvent) {
  if (event.button === 1 || event.shiftKey) {
    view.panning = true;
    view.panLast = { x: event.clientX, y: event.clientY };
    return;
  }
  if (event.button === 2) return handleRightClick(event);
  view.dragging = true;
  view.dragStart = { x: event.clientX, y: event.clientY };
  view.dragCurrent = { x: event.clientX, y: event.clientY };
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
  if (view.buildMode) {
    placeBuilding();
    return;
  }
  if (view.rallyModeBuildingId) {
    setRallyPointFromScreen(event.clientX, event.clientY);
    return;
  }
  if (dx < 5 && dy < 5) selectAt(event.clientX, event.clientY);
  else selectBox();
  ui.render();
}

function handleRightClick(event: MouseEvent) {
  view.buildMode = null;
  view.rallyModeBuildingId = null;
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
    });
  } else if (hit?.kind === "resource" || (hit?.kind === "building" && hit.canBeGatheredBy(state.playerId!))) {
    issue({ type: "gather", unitIds: ownUnits, targetId: hit.id }, { silent: true }).then((result) => {
      addTargetFlash(hit.id, result.ok ? "white" : "red");
    });
  } else if (hit?.ownerId && hit.ownerId !== state.playerId) {
    issue({ type: "attack", unitIds: ownUnits, targetId: hit.id }, { silent: true }).then((result) => {
      addTargetFlash(hit.id, result.ok ? "white" : "red");
    });
  } else {
    const iso = screenToIso(event.clientX, event.clientY, view.camera);
    issue({ type: "move", unitIds: ownUnits, x: iso.x, y: iso.y }).then((result) => {
      if (result.ok) addMoveCross(iso.x, iso.y);
    });
  }
}

function setRallyPointFromScreen(x: number, y: number, buildingId = view.rallyModeBuildingId) {
  if (!buildingId) return;
  const iso = screenToIso(x, y, view.camera);
  issue({ type: "setRallyPoint", buildingId, x: iso.x, y: iso.y }).then((result) => {
    if (result.ok) addMoveCross(iso.x, iso.y);
  });
  view.rallyModeBuildingId = null;
}

function placeBuilding() {
  const mode = view.buildMode;
  if (!mode) return;
  const unitIds = [...state.selectedIds].filter((id) => state.snapshot?.units[id]?.ownerId === state.playerId);
  if (!view.hoverTile || unitIds.length === 0) return;
  if (!canAfford(BUILDINGS[mode as keyof typeof BUILDINGS]?.cost || {}) || !canPlacePreview(mode as BuildingType, view.hoverTile.x, view.hoverTile.y)) {
    ui.showToast("Cannot place that building there.");
    return;
  }
  issue({ type: "build", unitIds, buildingType: mode as BuildingType, x: view.hoverTile.x, y: view.hoverTile.y });
  view.buildMode = null;
}

async function issue(payload: ClientCommand, options: { silent?: boolean } = {}) {
  if (!state.playerId) return { ok: false };
  const result = await sendCommand({ ...payload, playerId: state.playerId } as unknown as CommandPayload);
  if (!result.ok && !options.silent) ui.showToast(result.error || "Command failed.");
  return result;
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

function selectAt(x: number, y: number) {
  state.selectedIds.clear();
  const hit = hitTest(x, y);
  if (hit) state.selectedIds.add(hit.id);
}

function selectBox() {
  if (!state.snapshot) return;
  state.selectedIds.clear();
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
}

function onKeyDown(event: KeyboardEvent) {
  if (document.getElementById("game")?.classList.contains("hidden") || (event.target as HTMLElement)?.matches?.("input, button")) return;
  const key = event.key.toLowerCase();
  if (key === "escape") {
    view.buildMode = null;
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
  const buildShortcuts: Record<string, string> = { h: "house", f: "farm", b: "barracks", t: "watchTower", l: "lumberCamp", d: "foodDepot", m: "miningCamp" };
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
    return unit?.ownerId === state.playerId && unitBehavior(unit).canBuild();
  });
  if (!hasBuilder) return ui.showToast("Select build-capable units.");
  const def = BUILDINGS[buildingType as keyof typeof BUILDINGS];
  if (!def) return;
  if (!canAfford(def.cost || {})) return ui.showToast("Not enough resources.");
  view.buildMode = buildingType;
  ui.showToast(`Place ${def.label}.`);
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
  if (!train || !canAfford(train.cost || {})) return ui.showToast("Not enough resources.");
  if (player.population >= player.popCap) return ui.showToast("Population cap reached.");
  if (building.queue?.length >= 10) return ui.showToast("Training queue is full.");
  issue({ type: "train", buildingId: building.id, unitType });
}

function selectedFarmAction(action: (farm: Building) => void) {
  const farm = [...state.selectedIds].map((id) => state.snapshot?.buildings[id]).find((entity) => entity?.ownerId === state.playerId && entity.gatherResource());
  if (farm) action(farm);
}

function deleteSelectedBuilding() {
  const building = [...state.selectedIds].map((id) => state.snapshot?.buildings[id]).find((entity) => entity?.ownerId === state.playerId);
  if (building) issue({ type: "deleteBuilding", buildingId: building.id });
}

function selectIdleWorkers() {
  const idle = Object.values(state.snapshot?.units || {})
    .filter((unit) => unit.ownerId === state.playerId && unitBehavior(unit).canGather() && (!unit.command || unit.command.type === "idle"))
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

function canPlacePreview(buildingType: BuildingType, x: number, y: number) {
  if (!state.snapshot || !BUILDINGS[buildingType as keyof typeof BUILDINGS]) return false;
  const size = buildingSize(buildingType);
  if (x < 0 || y < 0 || x + size > state.snapshot.map.size || y + size > state.snapshot.map.size) return false;
  for (const building of Object.values(state.snapshot.buildings)) {
    if (rectsOverlap({ x, y, size }, building)) return false;
  }
  for (const resource of Object.values(state.snapshot.resources)) {
    if (pointInFootprint(Math.floor(resource.x), Math.floor(resource.y), x, y, size)) return false;
  }
  return true;
}

function buildingSize(type: BuildingType) {
  if (type in BUILDING_DEFS) return BUILDING_DEFS[type as keyof typeof BUILDING_DEFS].stats.size;
  if (type === "barracks") return 3;
  if (type === "house") return 2;
  return 1;
}

function rectsOverlap(a: { x: number; y: number; size: number }, b: { x: number; y: number; size: number }) {
  return a.x < b.x + b.size && a.x + a.size > b.x && a.y < b.y + b.size && a.y + a.size > b.y;
}

function pointInFootprint(px: number, py: number, x: number, y: number, size: number) {
  return px >= x && px < x + size && py >= y && py < y + size;
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
  view.camera.x = Math.round(view.camera.x);
  view.camera.y = Math.round(view.camera.y);
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

function forgetVisibleMissing(memory: Record<string, Building | ResourceNode | { x: number; y: number; size?: number }>, current: Record<string, Building | ResourceNode | Ruin>) {
  const visibility = state.snapshot?.visibility;
  if (!visibility) return;
  const mapSize = state.snapshot!.map.size;
  for (const [id, entity] of Object.entries(memory)) {
    if (!current[id] && isVisibleNow(visibility, entity.x, entity.y, entity.size || 1, mapSize)) delete memory[id];
  }
}

function isVisibleNow(visibility: ClientSnapshot["visibility"], x: number, y: number, size: number, mapSize: number) {
  const visible = visibility?.visibleSet;
  if (!visible) return false;
  for (let yy = Math.floor(y); yy < Math.ceil(y + size); yy += 1) {
    for (let xx = Math.floor(x); xx < Math.ceil(x + size); xx += 1) {
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
  ];
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

function renderedEntityRect(entity: Unit | Building | ResourceNode) {
  const spriteName = entity.type;
  const rows = sprites[spriteName] || sprites.house;
  const bounds = spriteBounds(rows);
  const scale = entityPixel(entity, view.camera.zoom || 1);
  const center = entity.kind === "building"
    ? isoToScreen(entity.x + ((entity.size || 1) - 1) / 2, entity.y + ((entity.size || 1) - 1) / 2, view.camera)
    : isoToScreen(entity.x + (entity.size || 0) / 2, entity.y + (entity.size || 0) / 2, view.camera);
  const visualWidth = bounds.width * scale;
  const visualHeight = bounds.height * scale;
  const left = Math.round(center.x - visualWidth / 2);
  const top = Math.round(center.y + ((entity.size || 0) * TILE_H * (view.camera.zoom || 1)) / 2 - visualHeight);
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

function hitPadding(entity: { kind: string }) {
  const zoom = view.camera.zoom || 1;
  if (entity.kind === "building") return 10 * zoom;
  if (entity.kind === "resource") return 8 * zoom;
  return 5 * zoom;
}

function worldPixel(zoom: number) {
  return Math.max(2, Math.round(SCALE * zoom));
}

function entityPixel(entity: Unit | Building | ResourceNode, zoom: number) {
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
    if (!state.snapshot.units[id] && !state.snapshot.buildings[id] && !state.snapshot.resources[id]) state.selectedIds.delete(id);
  }
}
