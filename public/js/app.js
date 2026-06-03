import { join, leave, sendCommand } from "./api.js";
import { Renderer } from "./render.js";
import { screenToIso, isoToScreen } from "./iso.js";
import { UI } from "./ui.js";
import { SCALE } from "./constants.js";
import { sprites } from "./sprites/index.js";
import { spriteBounds } from "./spriteBounds.js";

const state = {
  playerId: localStorage.getItem("rtsPlayerId") || null,
  snapshot: null,
  selectedIds: new Set(),
  lastSeen: { buildings: {}, resources: {}, ruins: {} },
};

const view = {
  camera: { x: window.innerWidth / 2, y: 90, zoom: 1 },
  dragging: false,
  panning: false,
  dragStart: null,
  dragCurrent: null,
  panLast: null,
  selectedIds: state.selectedIds,
  buildMode: null,
  hoverTile: null,
  mouse: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
};

const ZOOM_STEPS = [0.75, 1, 1.25, 1.5, 1.75, 2];

const canvas = document.getElementById("world");
const minimap = document.getElementById("minimap");
const renderer = new Renderer(canvas);
const ui = new UI(state, {
  setBuildMode(type) {
    view.buildMode = type;
  },
  train(buildingId, unitType) {
    issue({ type: "train", buildingId, unitType });
  },
  toggleAutoFarm() {
    issue({ type: "toggleAutoFarm" });
  },
  replenishFarm(farmId) {
    issue({ type: "replenishFarm", farmId });
  },
  async respawn() {
    await leave(state.playerId);
    localStorage.removeItem("rtsPlayerId");
    window.location.reload();
  },
});

document.getElementById("joinForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = document.getElementById("nameInput").value.trim() || "Player";
  const result = await join(name);
  if (!result.ok) {
    ui.showToast(result.error || "Could not join.");
    return;
  }
  state.playerId = result.playerId;
  localStorage.setItem("rtsPlayerId", result.playerId);
  enterGame();
});

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
  view.camera.zoom = nextZoom(view.camera.zoom, event.deltaY < 0 ? 1 : -1);
  const after = isoToScreen(before.x, before.y, view.camera);
  view.camera.x = Math.round(view.camera.x + event.clientX - after.x);
  view.camera.y = Math.round(view.camera.y + event.clientY - after.y);
  clampCamera();
});
minimap.addEventListener("mousedown", (event) => moveCameraFromMinimap(event));
minimap.addEventListener("mousemove", (event) => {
  if (event.buttons === 1) moveCameraFromMinimap(event);
});

renderer.resize();
drawLoop();

function enterGame() {
  document.getElementById("join").classList.add("hidden");
  document.getElementById("game").classList.remove("hidden");
  connectEvents();
}

function connectEvents() {
  const events = new EventSource(`/events?playerId=${encodeURIComponent(state.playerId)}`);
  events.onmessage = (event) => {
    state.snapshot = JSON.parse(event.data);
    rememberStaticObjects();
    cullSelection();
    ui.render();
    centerOnTownOnce();
  };
  events.onerror = () => ui.showToast("Connection interrupted.");
}

let centered = false;
function centerOnTownOnce() {
  if (centered || !state.snapshot) return;
  const town = Object.values(state.snapshot.buildings).find((building) => building.ownerId === state.playerId && building.type === "townCenter");
  if (!town) return;
  const screen = isoToScreen(town.x + 1, town.y + 1, { x: 0, y: 0, zoom: view.camera.zoom });
  view.camera.x = window.innerWidth / 2 - screen.x;
  view.camera.y = window.innerHeight / 2 - screen.y;
  clampCamera();
  centered = true;
}

function drawLoop() {
  edgePan();
  renderer.draw(state, view);
  requestAnimationFrame(drawLoop);
}

function onMouseDown(event) {
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

function onMouseMove(event) {
  view.mouse = { x: event.clientX, y: event.clientY };
  const iso = screenToIso(event.clientX, event.clientY, view.camera);
  view.hoverTile = { x: Math.floor(iso.x), y: Math.floor(iso.y) };
  if (view.panning) {
    view.camera.x += event.clientX - view.panLast.x;
    view.camera.y += event.clientY - view.panLast.y;
    clampCamera();
    view.panLast = { x: event.clientX, y: event.clientY };
  }
  if (view.dragging) view.dragCurrent = { x: event.clientX, y: event.clientY };
}

function onMouseUp(event) {
  if (view.panning) {
    view.panning = false;
    return;
  }
  if (!view.dragging || event.button !== 0) return;
  view.dragging = false;
  const dx = Math.abs(view.dragCurrent.x - view.dragStart.x);
  const dy = Math.abs(view.dragCurrent.y - view.dragStart.y);
  if (view.buildMode) {
    placeBuilding();
    return;
  }
  if (dx < 5 && dy < 5) selectAt(event.clientX, event.clientY);
  else selectBox();
  ui.render();
}

function handleRightClick(event) {
  view.buildMode = null;
  const hit = hitTest(event.clientX, event.clientY);
  const ownUnits = [...state.selectedIds].filter((id) => state.snapshot?.units[id]?.ownerId === state.playerId);
  if (ownUnits.length === 0) return;
  if (hit?.kind === "resource" || hit?.type === "farm") {
    issue({ type: "gather", unitIds: ownUnits, targetId: hit.id });
  } else if (hit?.ownerId && hit.ownerId !== state.playerId) {
    issue({ type: "attack", unitIds: ownUnits, targetId: hit.id });
  } else {
    const iso = screenToIso(event.clientX, event.clientY, view.camera);
    issue({ type: "move", unitIds: ownUnits, x: iso.x, y: iso.y });
  }
}

function placeBuilding() {
  const unitIds = [...state.selectedIds].filter((id) => state.snapshot?.units[id]?.ownerId === state.playerId);
  if (!view.hoverTile || unitIds.length === 0) return;
  issue({ type: "build", unitIds, buildingType: view.buildMode, x: view.hoverTile.x, y: view.hoverTile.y });
  view.buildMode = null;
}

async function issue(payload) {
  if (!state.playerId) return;
  const result = await sendCommand({ ...payload, playerId: state.playerId });
  if (!result.ok) ui.showToast(result.error || "Command failed.");
}

function selectAt(x, y) {
  state.selectedIds.clear();
  const hit = hitTest(x, y);
  if (hit) state.selectedIds.add(hit.id);
}

function selectBox() {
  state.selectedIds.clear();
  const left = Math.min(view.dragStart.x, view.dragCurrent.x);
  const right = Math.max(view.dragStart.x, view.dragCurrent.x);
  const top = Math.min(view.dragStart.y, view.dragCurrent.y);
  const bottom = Math.max(view.dragStart.y, view.dragCurrent.y);
  for (const unit of Object.values(state.snapshot.units)) {
    if (unit.ownerId !== state.playerId) continue;
    const p = isoToScreen(unit.x, unit.y, view.camera);
    if (p.x >= left && p.x <= right && p.y >= top - 40 && p.y <= bottom) state.selectedIds.add(unit.id);
  }
}

function edgePan() {
  if (!document.getElementById("game") || document.getElementById("game").classList.contains("hidden")) return;
  const margin = 28;
  const speed = 10;
  if (view.mouse.x <= margin) view.camera.x += speed;
  if (view.mouse.x >= window.innerWidth - margin) view.camera.x -= speed;
  if (view.mouse.y <= margin) view.camera.y += speed;
  if (view.mouse.y >= window.innerHeight - margin) view.camera.y -= speed;
  clampCamera();
}

function nextZoom(current, direction) {
  const index = ZOOM_STEPS.reduce((best, value, i) => (
    Math.abs(value - current) < Math.abs(ZOOM_STEPS[best] - current) ? i : best
  ), 0);
  return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, index + direction))];
}

function moveCameraFromMinimap(event) {
  if (!state.snapshot) return;
  const rect = minimap.getBoundingClientRect();
  const point = minimapScreenToIso(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height, state.snapshot.map.size);
  const x = Math.max(0, Math.min(state.snapshot.map.size - 1, point.x));
  const y = Math.max(0, Math.min(state.snapshot.map.size - 1, point.y));
  const screen = isoToScreen(x, y, { x: 0, y: 0, zoom: view.camera.zoom });
  view.camera.x = window.innerWidth / 2 - screen.x;
  view.camera.y = window.innerHeight / 2 - screen.y;
  clampCamera();
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

function clampAxis(cameraValue, mapMin, mapMax, mapSpan, viewSpan, margin) {
  if (mapSpan + margin * 2 <= viewSpan) {
    return viewSpan / 2 - (mapMin + mapMax) / 2;
  }
  const low = viewSpan - margin - mapMax;
  const high = margin - mapMin;
  return Math.max(low, Math.min(high, cameraValue));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function minimapScreenToIso(px, py, width, height, size) {
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
  for (const [id, building] of Object.entries(state.snapshot.buildings)) state.lastSeen.buildings[id] = building;
  for (const [id, resource] of Object.entries(state.snapshot.resources)) state.lastSeen.resources[id] = resource;
  for (const [id, ruin] of Object.entries(state.snapshot.ruins)) state.lastSeen.ruins[id] = ruin;
}

function hitTest(x, y) {
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

function renderedEntityRect(entity) {
  const spriteName = entity.type || entity.sprite;
  const rows = sprites[spriteName] || sprites.house;
  const bounds = spriteBounds(rows);
  const scale = worldPixel(view.camera.zoom || 1);
  const center = isoToScreen(entity.x + (entity.size || 0) / 2, entity.y + (entity.size || 0) / 2, view.camera);
  const visualWidth = bounds.width * scale;
  const visualHeight = bounds.height * scale;
  const flat = entity.type === "farm";
  const left = Math.round(center.x - visualWidth / 2);
  const top = Math.round(flat ? center.y - visualHeight / 2 : center.y - visualHeight);
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

function hitPadding(entity) {
  const zoom = view.camera.zoom || 1;
  if (entity.kind === "building") return 10 * zoom;
  if (entity.kind === "resource") return 8 * zoom;
  return 5 * zoom;
}

function worldPixel(zoom) {
  return Math.max(2, Math.round(SCALE * zoom));
}

function cullSelection() {
  if (!state.snapshot) return;
  for (const id of [...state.selectedIds]) {
    if (!state.snapshot.units[id] && !state.snapshot.buildings[id] && !state.snapshot.resources[id]) state.selectedIds.delete(id);
  }
}
