import { SCALE, TILE_H, TILE_W } from "./constants.js";
import { BUILDING_DEFS } from "../../src/shared/buildingRegistry.js";
import { isoToScreen } from "./iso.js";
import { palette } from "./sprites/palette.js";
import { sprites } from "./sprites/index.js";
import { spriteBounds } from "./spriteBounds.js";
import type { Building, BuildingType, ResourceNode, ResourceType, Ruin, SpriteName, Unit } from "../../src/shared/types.js";
import type { CameraState, ClientSnapshot, Effect, GameState, ViewState } from "./clientTypes.js";

const tileColors = ["#345f3e", "#386846", "#2f5739"];
const GROUND_TILE = [
  "................",
  "......aaaa......",
  "....aaaaaaaa....",
  "..aaaaaaaaaaaa..",
  "aaaaaaaaaaaaaaaa",
  "..bbbbbbbbbbbb..",
  "....bbbbbbbb....",
  "......bbbb......",
];
const GROUND_PALETTE = {
  ".": null,
  a: "#386846",
  b: "#2f5739",
};

export class Renderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  currentZoom: number;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Missing canvas context");
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;
    this.currentZoom = 1;
  }

  resize() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
  }

  draw(state: GameState, view: ViewState) {
    const { ctx } = this;
    const width = window.innerWidth;
    const height = window.innerHeight;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = state.snapshot?.visibility ? "#111813" : "#315f3c";
    ctx.fillRect(0, 0, width, height);
    if (!state.snapshot) return;
    this.currentZoom = view.camera.zoom || 1;
    this.drawTiles(state.snapshot.map.size, view.camera, state.snapshot.visibility);
    this.drawLastSeen(state, view);

    const entities = [
      ...Object.values(state.snapshot.resources),
      ...Object.values(state.snapshot.ruins).map((ruin) => ({ ...ruin, sprite: "ruin" })),
      ...Object.values(state.snapshot.buildings),
      ...Object.values(state.snapshot.units),
    ].filter((entity) => isEntityNearViewport(entity, view.camera)).sort((a, b) => (a.x + a.y) - (b.x + b.y));

    for (const entity of entities) this.drawEntity(entity, state, view);
    this.drawEffects(state, view);
    this.drawPlacement(view, state);
    this.drawSelectionBox(view);
    this.drawMinimap(state, view);
  }

  drawTiles(size: number, camera: CameraState, visibility: ClientSnapshot["visibility"]) {
    const exploredSet = visibility?.exploredSet;
    const visibleSet = visibility?.visibleSet;
    const bounds = visibleTileBounds(size, camera);
    for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
      for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
        const key = y * size + x;
        if (visibility && !exploredSet?.has(key)) continue;
        const screen = isoToScreen(x, y, camera);
        if (screen.x < -80 || screen.x > window.innerWidth + 80 || screen.y < -50 || screen.y > window.innerHeight + 80) continue;
        const visible = !visibility || (visibleSet?.has(key) ?? false);
        const color = visible ? tileColors[(x + y) % tileColors.length]! : "#1e3025";
        this.drawTile(screen.x, screen.y, color, visible);
      }
    }
  }

  drawTile(cx: number, cy: number, color: string, visible: boolean) {
    const zoom = this.currentZoom || 1;
    const halfW = (TILE_W * zoom) / 2 + 1.5;
    const halfH = (TILE_H * zoom) / 2 + 1.5;
    this.ctx.fillStyle = visible ? color : "#1e3025";
    this.ctx.beginPath();
    this.ctx.moveTo(cx, cy - halfH);
    this.ctx.lineTo(cx + halfW, cy);
    this.ctx.lineTo(cx, cy + halfH);
    this.ctx.lineTo(cx - halfW, cy);
    this.ctx.closePath();
    this.ctx.fill();
    const px = worldPixel(this.currentZoom || 1);
    const startX = Math.round(cx - 8 * px);
    const startY = Math.round(cy - 4 * px);
    for (let y = 0; y < GROUND_TILE.length; y += 1) {
      const groundRow = GROUND_TILE[y]!;
      for (let x = 0; x < groundRow.length; x += 1) {
        const key = groundRow[x]!;
        if (key === ".") continue;
        this.ctx.fillStyle = visible ? shade(color, key === "a" ? 1.06 : 0.88) : color;
        this.ctx.fillRect(startX + x * px, startY + y * px, px, px);
      }
    }
  }

  drawEntity(entity: RenderEntity, state: GameState, view: ViewState) {
    const spriteName = spriteNameFor(entity);
    const rows = sprites[spriteName];
    if (!rows) return;
    const center = entityCenter(entity, view.camera);
    const scale = entityScale(entity, view.camera.zoom || 1);
    const bounds = spriteBounds(rows);
    const visualWidth = bounds.width * scale;
    const x = Math.round(center.x - visualWidth / 2 - bounds.minX * scale);
    const y = Math.round(spriteTopY(entity, center.y, bounds, scale, view.camera.zoom || 1));
    const snap = state.snapshot!;
    const ownerId = entity.ownerId;
    const ownerColor = ownerId == null ? undefined : snap.players[ownerId]?.color;
    if (view.selectedIds.has(entity.id)) this.drawSelectionMarker(entity, view.camera, center.x, center.y, ownerColor || "#f4efe6");
    const flash = targetFlashFor(state, entity.id);
    const flip = "facing" in entity && entity.facing === "left";
    this.drawSprite(rows, x, y, ownerColor, flip, scale, flash.amount, flash.color);
    this.drawTeamAccent(entity, center.x, y, visualWidth, ownerColor);
    if ("attackFlash" in entity && entity.attackFlash > 0) this.drawAttackFlash(center.x, center.y, ownerColor || "#f4efe6");
    if (entity.kind === "unit") {
      const cmd = entity.command as { resourceKind?: ResourceType };
      if (entity.workFlash > 0) this.drawWorkFlash(center.x, center.y, entity.facing, cmd.resourceKind || entity.carried?.resource);
      if (entity.carried?.amount) this.drawCarryBadge(center.x, y - 2, entity.carried.resource);
    }
    if ("hp" in entity && entity.hp && entity.maxHp && entity.hp < entity.maxHp) this.drawHealth(center.x, y - 8, entity.hp / entity.maxHp);
    if (entity.kind === "building" && entity.gatherResource() && entity.maxAmount && entity.amount! < entity.maxAmount) this.drawHealth(center.x, y - 8, (entity.amount || 0) / entity.maxAmount);
    if (entity.kind === "resource" && entity.maxAmount && entity.amount < entity.maxAmount) this.drawHealth(center.x, y - 5, entity.amount / entity.maxAmount);
  }

  drawSprite(rows: readonly string[], x: number, y: number, playerColor: string | undefined, flip = false, scale = SCALE, flash = 0, flashColor = "white") {
    const { ctx } = this;
    if (flip) {
      ctx.save();
      ctx.translate(x + rows[0]!.length * scale, y);
      ctx.scale(-1, 1);
      x = 0;
      y = 0;
    }
    for (let py = 0; py < rows.length; py += 1) {
      const spriteRow = rows[py]!;
      for (let px = 0; px < spriteRow.length; px += 1) {
        const key = spriteRow[px]!;
        let color = key === "p" || key === "P" ? (key === "P" ? lighten(playerColor) : playerColor) : palette[key as keyof typeof palette];
        if (!color) continue;
        if (flash > 0) color = flashColor === "red" ? redFlash(color, flash) : brighten(color, 1 + flash * 1.35);
        ctx.fillStyle = color;
        ctx.fillRect(x + px * scale, y + py * scale, scale, scale);
      }
    }
    if (flip) ctx.restore();
  }

  drawCarryBadge(x: number, y: number, resource: "wood" | "ore" | "food") {
    const { ctx } = this;
    ctx.fillStyle = resource === "wood" ? "#8b623e" : resource === "ore" ? "#c1b77b" : "#6fa04a";
    ctx.fillRect(x - 5, y, 10, 6);
    ctx.fillStyle = "#111813";
    ctx.fillRect(x - 3, y + 4, 6, 2);
  }

  drawAttackFlash(x: number, y: number, color: string) {
    const { ctx } = this;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x - 18, y - 26);
    ctx.lineTo(x + 18, y - 8);
    ctx.stroke();
  }

  drawWorkFlash(x: number, y: number, facing: "left" | "right" = "right", resource: "wood" | "ore" | "food" = "wood") {
    const { ctx } = this;
    const dir = facing === "left" ? -1 : 1;
    const t = Math.floor(performance.now() / 120) % 2;
    const swingY = t ? -38 : -30;
    ctx.fillStyle = resource === "ore" ? "#c1b77b" : resource === "food" ? "#6fa04a" : "#e9bd59";
    ctx.fillRect(Math.round(x + dir * 8), Math.round(y + swingY), 14 * dir, 4);
    ctx.fillStyle = resource === "ore" ? "#687276" : "#4b3728";
    ctx.fillRect(Math.round(x + dir * 18), Math.round(y + swingY + 4), 8 * dir, 4);
  }

  drawEffects(state: GameState, view: ViewState) {
    const { ctx } = this;
    const now = performance.now();
    for (const effect of state.effects || []) {
      const life = Math.max(0, Math.min(1, (now - effect.createdAt) / effect.duration));
      if (effect.type !== "moveCross") continue;
      const p = isoToScreen(effect.x, effect.y, view.camera);
      const alpha = 1 - life;
      const px = worldPixel(view.camera.zoom || 1);
      ctx.save();
      ctx.globalAlpha *= alpha;
      ctx.fillStyle = "#d83f34";
      const s = px * 2;
      ctx.fillRect(Math.round(p.x - s / 2), Math.round(p.y - px * 5), s, px * 10);
      ctx.fillRect(Math.round(p.x - px * 5), Math.round(p.y - s / 2), px * 10, s);
      ctx.fillStyle = "#ffd2c9";
      ctx.fillRect(Math.round(p.x - px / 2), Math.round(p.y - px / 2), px, px);
      ctx.restore();
    }
  }

  drawHealth(x: number, y: number, pct: number) {
    const { ctx } = this;
    ctx.fillStyle = "#1b1715";
    ctx.fillRect(x - 18, y, 36, 5);
    ctx.fillStyle = pct > 0.45 ? "#5fbf64" : "#d8714f";
    ctx.fillRect(x - 17, y + 1, Math.max(1, 34 * pct), 3);
  }

  drawSelectionMarker(entity: RenderEntity, camera: CameraState, x: number, y: number, color: string) {
    if (entity.kind === "building" || entity.kind === "ruin") {
      this.drawFootprint(entity.x, entity.y, entity.size || 1, camera, color, "rgb(17 24 19 / 0.82)", 3);
      return;
    }
    const zoom = this.currentZoom || 1;
    const px = worldPixel(zoom);
    const size = entity.size || 0.8;
    const rx = Math.max(5, Math.round(size * 8));
    const ry = Math.max(3, Math.round(size * 4));
    for (let row = -ry; row <= ry; row += 1) {
      const width = Math.round(rx * (1 - Math.abs(row) / (ry + 1)));
      for (let col = -width; col <= width; col += 1) {
        const edge = Math.abs(col) === width || Math.abs(row) === ry;
        this.ctx.fillStyle = edge ? color : "rgb(17 24 19 / 0.9)";
        this.ctx.fillRect(Math.round(x + col * px), Math.round(y + row * px), px, px);
      }
    }
  }

  drawTeamAccent(entity: RenderEntity, centerX: number, topY: number, visualWidth: number, color: string | undefined) {
    if (!color || !entity.ownerId) return;
    const px = worldPixel(this.currentZoom || 1);
    const { ctx } = this;
    if (entity.kind === "building") {
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(centerX - visualWidth * 0.18), Math.round(topY + px * 2), Math.max(px * 3, visualWidth * 0.16), px * 2);
      ctx.fillStyle = "#f4efe6";
      ctx.fillRect(Math.round(centerX - visualWidth * 0.18), Math.round(topY + px * 2), px, px);
    } else if (entity.kind === "unit") {
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(centerX - px * 3), Math.round(topY + px * 7), px * 5, px * 2);
    }
  }

  drawSelectionBox(view: ViewState) {
    if (!view.dragging || !view.dragCurrent || !view.dragStart) return;
    const { ctx } = this;
    const x = Math.min(view.dragStart!.x, view.dragCurrent.x);
    const y = Math.min(view.dragStart!.y, view.dragCurrent.y);
    const w = Math.abs(view.dragCurrent.x - view.dragStart!.x);
    const h = Math.abs(view.dragCurrent.y - view.dragStart!.y);
    ctx.strokeStyle = "#f4efe6";
    ctx.fillStyle = "rgb(244 239 230 / 0.12)";
    ctx.strokeRect(x, y, w, h);
    ctx.fillRect(x, y, w, h);
  }

  drawPlacement(view: ViewState, state: GameState) {
    const mode = view.buildMode;
    if (!mode) return;
    const { ctx } = this;
    const tile = view.hoverTile;
    if (!tile) return;
    const size = buildingSize(mode);
    const valid = canPlacePreview(state, mode, tile.x, tile.y);
    const stroke = valid ? "#e9bd59" : "#d84b3e";
    const fill = valid ? "rgb(233 189 89 / 0.28)" : "rgb(216 75 62 / 0.28)";
    this.drawFootprint(tile.x, tile.y, size, view.camera, stroke, fill, 2);
    const rows = sprites[mode as SpriteName];
    if (rows) {
      const center = footprintCenter(tile.x, tile.y, size, view.camera);
      const scale = entityScale({ kind: "building", type: mode as BuildingType, size } as RenderEntity, view.camera.zoom || 1);
      const bounds = spriteBounds(rows);
      const visualWidth = bounds.width * scale;
      ctx.globalAlpha = 0.72;
      const y = spriteTopY({ kind: "building", type: mode as BuildingType, size } as RenderEntity, center.y, bounds, scale, view.camera.zoom || 1);
      this.drawSprite(rows, Math.round(center.x - visualWidth / 2 - bounds.minX * scale), Math.round(y), state.snapshot?.players[state.playerId!]?.color, false, scale, valid ? 0 : 0.75, valid ? "white" : "red");
      ctx.globalAlpha = 1;
    }
  }

  drawFootprint(x: number, y: number, size: number, camera: CameraState, stroke: string, fill: string, lineWidth = 2) {
    const { ctx } = this;
    const points = [
      isoToScreen(x - 0.5, y - 0.5, camera),
      isoToScreen(x + size - 0.5, y - 0.5, camera),
      isoToScreen(x + size - 0.5, y + size - 0.5, camera),
      isoToScreen(x - 0.5, y + size - 0.5, camera),
    ];
    ctx.save();
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  drawLastSeen(state: GameState, view: ViewState) {
    if (!state.snapshot?.visibility) return;
    const visibleIds = new Set([
      ...Object.keys(state.snapshot.buildings),
      ...Object.keys(state.snapshot.resources),
      ...Object.keys(state.snapshot.ruins),
    ]);
    const mapSize = state.snapshot.map.size;
    const remembered = [
      ...Object.values(state.lastSeen.buildings),
      ...Object.values(state.lastSeen.resources),
      ...Object.values(state.lastSeen.ruins).map((ruin) => ({ ...ruin, sprite: "ruin" })),
    ].filter((entity) => !visibleIds.has(entity.id) && isExplored(state.snapshot!.visibility, entity.x, entity.y, entity.size || 1, mapSize));
    this.ctx.globalAlpha = 0.35;
    for (const entity of remembered.filter((entity) => isEntityNearViewport(entity, view.camera)).sort((a, b) => (a.x + a.y) - (b.x + b.y))) this.drawEntity(entity, state, view);
    this.ctx.globalAlpha = 1;
  }

  drawMinimap(state: GameState, view: ViewState) {
    const minimap = document.getElementById("minimap") as HTMLCanvasElement | null;
    if (!minimap || !state.snapshot) return;
    const ctx = minimap.getContext("2d")!;
    const size = state.snapshot.map.size;
    const project = (x: number, y: number) => minimapIsoToScreen(x, y, size, minimap.width, minimap.height);
    ctx.clearRect(0, 0, minimap.width, minimap.height);
    ctx.fillStyle = "#101612";
    ctx.fillRect(0, 0, minimap.width, minimap.height);

    ctx.fillStyle = "#172219";
    ctx.beginPath();
    ctx.moveTo(minimap.width / 2, 6);
    ctx.lineTo(minimap.width - 6, minimap.height / 2);
    ctx.lineTo(minimap.width / 2, minimap.height - 6);
    ctx.lineTo(6, minimap.height / 2);
    ctx.closePath();
    ctx.fill();

    const visibility = state.snapshot.visibility;
    const exploredSet = visibility?.exploredSet;
    const visibleSet = visibility?.visibleSet;
    if (exploredSet) {
      for (const key of exploredSet) {
        const x = key % size;
        const y = Math.floor(key / size);
        const p = project(x + 0.5, y + 0.5);
        ctx.fillStyle = visibleSet?.has(key) ? "#356743" : "#223629";
        ctx.fillRect(Math.round(p.x), Math.round(p.y), 2, 2);
      }
    }
    for (const building of Object.values(state.snapshot.buildings)) {
      const player = state.snapshot.players[building.ownerId];
      const p = project(building.x + (building.size - 1) / 2, building.y + (building.size - 1) / 2);
      ctx.fillStyle = player?.color || "#d8d0c0";
      ctx.fillRect(Math.round(p.x - 2), Math.round(p.y - 2), Math.max(3, building.size + 2), Math.max(3, building.size + 2));
    }
    for (const unit of Object.values(state.snapshot.units)) {
      const player = state.snapshot.players[unit.ownerId];
      const p = project(unit.x, unit.y);
      ctx.fillStyle = player?.color || "#d8d0c0";
      ctx.fillRect(Math.round(p.x), Math.round(p.y), 2, 2);
    }
    this.drawMinimapViewport(ctx, state, view, project);
  }

  drawMinimapViewport(ctx: CanvasRenderingContext2D, state: GameState, view: ViewState, project: (x: number, y: number) => { x: number; y: number }) {
    const corners = [
      { x: 0, y: 0 },
      { x: window.innerWidth, y: 0 },
      { x: window.innerWidth, y: window.innerHeight },
      { x: 0, y: window.innerHeight },
    ].map((point) => screenToIsoLocal(point.x, point.y, view.camera));
    ctx.strokeStyle = "#f4efe6";
    ctx.lineWidth = 1;
    ctx.beginPath();
    corners.forEach((corner, index) => {
      const p = project(corner.x, corner.y);
      if (index === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.stroke();
  }
}

function spriteNameFor(entity: RenderEntity): SpriteName {
  if (entity.kind === "ruin") return "ruin";
  if (entity.kind === "resource") {
    if (entity.type === "tree" || entity.type === "ore" || entity.type === "stump" || entity.type === "berry") return entity.type;
  }
  return entity.type as SpriteName;
}

function targetFlashFor(state: GameState, id: string) {
  const effect = (state.effects || []).find((item): item is Extract<Effect, { type: "targetFlash" }> => item.type === "targetFlash" && item.targetId === id);
  if (!effect) return { amount: 0, color: "white" };
  return { amount: Math.max(0, 1 - (performance.now() - effect.createdAt) / effect.duration), color: effect.color || "white" };
}

function buildingSize(type: string) {
  if (type in BUILDING_DEFS) return BUILDING_DEFS[type as keyof typeof BUILDING_DEFS].stats.size;
  if (type === "townCenter") return 4;
  if (type === "barracks") return 3;
  if (type === "house") return 2;
  if (type === "watchTower" || type === "lumberCamp" || type === "foodDepot" || type === "miningCamp") return 1;
  return 1;
}

function canPlacePreview(state: GameState, buildingType: string, x: number, y: number) {
  if (!state.snapshot) return false;
  const size = buildingSize(buildingType);
  const player = state.snapshot.players[state.playerId!];
  const cost = buildingCost(buildingType);
  if (!Object.entries(cost).every(([resource, amount]) => (player?.resources?.[resource as ResourceType] || 0) >= (amount as number))) return false;
  if (x < 0 || y < 0 || x + size > state.snapshot.map.size || y + size > state.snapshot.map.size) return false;
  for (const building of Object.values(state.snapshot.buildings)) {
    if (rectsOverlap({ x, y, size }, building)) return false;
  }
  for (const resource of Object.values(state.snapshot.resources)) {
    const px = Math.floor(resource.x);
    const py = Math.floor(resource.y);
    if (px >= x && px < x + size && py >= y && py < y + size) return false;
  }
  return true;
}

function buildingCost(type: string) {
  return type in BUILDING_DEFS ? BUILDING_DEFS[type as keyof typeof BUILDING_DEFS].stats.cost : {};
}

function rectsOverlap(a: { x: number; y: number; size: number }, b: { x: number; y: number; size: number }) {
  return a.x < b.x + b.size && a.x + a.size > b.x && a.y < b.y + b.size && a.y + a.size > b.y;
}

function entityCenter(entity: RenderEntity, camera: CameraState) {
  if (entity.kind === "building" || entity.kind === "ruin") return footprintCenter(entity.x, entity.y, entity.size || 1, camera);
  return isoToScreen(entity.x + (entity.size || 0) / 2, entity.y + (entity.size || 0) / 2, camera);
}

function isEntityNearViewport(entity: RenderEntity, camera: CameraState) {
  const size = entity.size || 1;
  const p = isoToScreen(entity.x + size / 2, entity.y + size / 2, camera);
  const margin = 260;
  return p.x >= -margin && p.x <= window.innerWidth + margin && p.y >= -margin && p.y <= window.innerHeight + margin;
}

function footprintCenter(x: number, y: number, size: number, camera: CameraState) {
  return isoToScreen(x + (size - 1) / 2, y + (size - 1) / 2, camera);
}

function lighten(color = "#ffffff") {
  return color;
}

function entityScale(entity: RenderEntity, zoom: number) {
  return worldPixel(zoom);
}

function spriteTopY(entity: RenderEntity, centerY: number, bounds: { maxY: number }, scale: number, zoom: number) {
  const footprintBottom = centerY + ((entity.size || 0) * TILE_H * zoom) / 2;
  return footprintBottom - (bounds.maxY + 1) * scale;
}

function brighten(color = "#ffffff", factor = 1) {
  if (!color.startsWith("#")) return color;
  const n = Number.parseInt(color.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lift = (channel: number) => Math.max(0, Math.min(255, Math.round(channel * factor + 70 * (factor - 1))));
  return `rgb(${lift(r)} ${lift(g)} ${lift(b)})`;
}

function redFlash(color = "#ffffff", amount = 1) {
  if (!color.startsWith("#")) return color;
  const n = Number.parseInt(color.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const mix = (base: number, target: number) => Math.round(base + (target - base) * Math.min(1, amount * 0.9));
  return `rgb(${mix(r, 255)} ${mix(g, 42)} ${mix(b, 32)})`;
}

function shade(hex: string, factor: number) {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * factor)));
  const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * factor)));
  const b = Math.max(0, Math.min(255, Math.round((n & 255) * factor)));
  return `rgb(${r} ${g} ${b})`;
}

function isExplored(visibility: ClientSnapshot["visibility"], x: number, y: number, size: number, mapSize: number) {
  const explored = visibility?.exploredSet;
  if (!explored) return false;
  for (let yy = Math.floor(y); yy < Math.ceil(y + size); yy += 1) {
    for (let xx = Math.floor(x); xx < Math.ceil(x + size); xx += 1) {
      if (explored.has(yy * mapSize + xx)) return true;
    }
  }
  return false;
}

function screenToIsoLocal(x: number, y: number, camera: CameraState) {
  const zoom = camera.zoom || 1;
  const sx = (x - camera.x) / zoom;
  const sy = (y - camera.y) / zoom;
  return {
    x: sy / TILE_H + sx / TILE_W,
    y: sy / TILE_H - sx / TILE_W,
  };
}

function visibleTileBounds(size: number, camera: CameraState) {
  const margin = 140;
  const corners = [
    screenToIsoLocal(-margin, -margin, camera),
    screenToIsoLocal(window.innerWidth + margin, -margin, camera),
    screenToIsoLocal(window.innerWidth + margin, window.innerHeight + margin, camera),
    screenToIsoLocal(-margin, window.innerHeight + margin, camera),
  ];
  return {
    minX: clampInt(Math.floor(Math.min(...corners.map((point) => point.x))) - 3, 0, size - 1),
    maxX: clampInt(Math.ceil(Math.max(...corners.map((point) => point.x))) + 3, 0, size - 1),
    minY: clampInt(Math.floor(Math.min(...corners.map((point) => point.y))) - 3, 0, size - 1),
    maxY: clampInt(Math.ceil(Math.max(...corners.map((point) => point.y))) + 3, 0, size - 1),
  };
}

function clampInt(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function minimapIsoToScreen(x: number, y: number, size: number, width: number, height: number) {
  const usableW = width - 12;
  const usableH = height - 12;
  return {
    x: width / 2 + ((x - y) / size) * (usableW / 2),
    y: height / 2 + ((x + y - size) / size) * (usableH / 2),
  };
}

function worldPixel(zoom: number) {
  return Math.max(2, Math.round(SCALE * zoom));
}

type RenderEntity = Unit | Building | ResourceNode | Ruin;
