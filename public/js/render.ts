import { Application, BLEND_MODES, Container, Graphics, SCALE_MODES, Sprite, Texture } from "pixi.js";
import { SCALE, TILE_H, TILE_W } from "./constants.js";
import { BUILDING_DEFS } from "../../src/shared/buildingRegistry.js";
import { isoToScreen } from "./iso.js";
import { palette } from "./sprites/palette.js";
import { sprites } from "./sprites/index.js";
import { spriteBounds } from "./spriteBounds.js";
import type { Building, BuildingType, ResourceNode, ResourceType, Ruin, SoundDebugSource, SpriteName, Unit } from "../../src/shared/types.js";
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

type RenderEntity = Unit | Building | ResourceNode | Ruin;

export class Renderer {
  canvas: HTMLCanvasElement;
  app: Application;
  background: Graphics;
  terrainLayer: Container;
  selectionLayer: Graphics;
  entityLayer: Container;
  overlayLayer: Graphics;
  currentZoom: number;

  private tilePool: Sprite[] = [];
  private entitySprites = new Map<string, Sprite>();
  private flashSprites = new Map<string, Sprite>();
  private textureCache = new Map<string, Texture>();
  private tileTextureCache = new Map<string, Texture>();
  private lastMinimapDraw = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.app = new Application({
      view: canvas,
      width: window.innerWidth,
      height: window.innerHeight,
      resolution: Math.max(1, window.devicePixelRatio || 1),
      autoDensity: true,
      autoStart: false,
      antialias: false,
      backgroundAlpha: 1,
    });
    this.app.renderer.background.color = 0x315f3c;
    this.background = new Graphics();
    this.terrainLayer = new Container();
    this.selectionLayer = new Graphics();
    this.entityLayer = new Container();
    this.entityLayer.sortableChildren = true;
    this.overlayLayer = new Graphics();
    this.app.stage.addChild(this.background, this.terrainLayer, this.selectionLayer, this.entityLayer, this.overlayLayer);
    this.currentZoom = 1;
  }

  resize() {
    this.app.renderer.resolution = Math.max(1, window.devicePixelRatio || 1);
    this.app.renderer.resize(window.innerWidth, window.innerHeight);
  }

  draw(state: GameState, view: ViewState) {
    this.currentZoom = view.camera.zoom || 1;
    this.drawBackground(state);
    this.overlayLayer.clear();
    this.selectionLayer.clear();
    if (!state.snapshot) {
      this.hideAllEntitySprites(new Set());
      this.hideUnusedTiles(0);
      this.app.render();
      return;
    }

    this.drawTiles(state.snapshot.map.size, view.camera, state.snapshot.visibility);
    const active = new Set<string>();
    this.drawLastSeen(state, view, active);
    this.drawEntities(state, view, active);
    this.hideAllEntitySprites(active);
    this.drawSoundDebug(state, view);
    this.drawEffects(state, view);
    this.drawPlacement(view, state);
    this.drawSelectionBox(view);
    this.drawMinimap(state, view);
    this.app.render();
  }

  private drawBackground(state: GameState) {
    const color = state.snapshot?.visibility ? 0x111813 : 0x315f3c;
    this.app.renderer.background.color = color;
    this.background.clear();
    this.background.beginFill(color);
    this.background.drawRect(0, 0, window.innerWidth, window.innerHeight);
    this.background.endFill();
  }

  private drawTiles(size: number, camera: CameraState, visibility: ClientSnapshot["visibility"]) {
    const exploredSet = visibility?.exploredSet;
    const visibleSet = visibility?.visibleSet;
    const bounds = visibleTileBounds(size, camera);
    let index = 0;
    for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
      for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
        const key = y * size + x;
        if (visibility && !exploredSet?.has(key)) continue;
        const screen = isoToScreen(x, y, camera);
        if (screen.x < -90 || screen.x > window.innerWidth + 90 || screen.y < -60 || screen.y > window.innerHeight + 60) continue;
        const visible = !visibility || (visibleSet?.has(key) ?? false);
        const color = visible ? tileColors[(x + y) % tileColors.length]! : "#1e3025";
        const tile = this.tileAt(index++);
        tile.texture = this.tileTexture(color, visible);
        tile.scale.set(this.currentZoom);
        tile.x = Math.round(screen.x - (tile.texture.width * this.currentZoom) / 2);
        tile.y = Math.round(screen.y - (tile.texture.height * this.currentZoom) / 2);
        tile.visible = true;
      }
    }
    this.hideUnusedTiles(index);
  }

  private tileAt(index: number) {
    let tile = this.tilePool[index];
    if (!tile) {
      tile = new Sprite();
      tile.roundPixels = true;
      this.tilePool[index] = tile;
      this.terrainLayer.addChild(tile);
    }
    return tile;
  }

  private hideUnusedTiles(start: number) {
    for (let i = start; i < this.tilePool.length; i += 1) this.tilePool[i]!.visible = false;
  }

  private tileTexture(color: string, visible: boolean) {
    const key = `${color}:${visible ? 1 : 0}`;
    const cached = this.tileTextureCache.get(key);
    if (cached) return cached;
    const canvas = document.createElement("canvas");
    canvas.width = TILE_W + 4;
    canvas.height = TILE_H + 4;
    const ctx = canvas.getContext("2d")!;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    ctx.fillStyle = visible ? color : "#1e3025";
    ctx.beginPath();
    ctx.moveTo(cx, cy - TILE_H / 2);
    ctx.lineTo(cx + TILE_W / 2, cy);
    ctx.lineTo(cx, cy + TILE_H / 2);
    ctx.lineTo(cx - TILE_W / 2, cy);
    ctx.closePath();
    ctx.fill();
    const px = SCALE;
    const startX = Math.round(cx - 8 * px);
    const startY = Math.round(cy - 4 * px);
    for (let y = 0; y < GROUND_TILE.length; y += 1) {
      const row = GROUND_TILE[y]!;
      for (let x = 0; x < row.length; x += 1) {
        const part = row[x]!;
        if (part === ".") continue;
        ctx.fillStyle = visible ? shade(color, part === "a" ? 1.06 : 0.88) : color;
        ctx.fillRect(startX + x * px, startY + y * px, px, px);
      }
    }
    const texture = Texture.from(canvas);
    texture.baseTexture.scaleMode = SCALE_MODES.NEAREST;
    this.tileTextureCache.set(key, texture);
    return texture;
  }

  private drawEntities(state: GameState, view: ViewState, active: Set<string>) {
    const snap = state.snapshot!;
    const entities = [
      ...Object.values(snap.resources),
      ...Object.values(snap.ruins).map((ruin) => ({ ...ruin, sprite: "ruin" })),
      ...Object.values(snap.buildings),
      ...Object.values(snap.units),
    ].filter((entity) => isEntityNearViewport(entity, view.camera));
    for (const entity of entities) this.updateEntitySprite(entity, state, view, active, 1, entity.id);
  }

  private drawLastSeen(state: GameState, view: ViewState, active: Set<string>) {
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
    ].filter((entity) => !visibleIds.has(entity.id) && isExplored(state.snapshot!.visibility, entity.x, entity.y, entity.size || 1, mapSize) && isEntityNearViewport(entity, view.camera));
    for (const entity of remembered) this.updateEntitySprite(entity, state, view, active, 0.35, `last:${entity.id}`);
  }

  private updateEntitySprite(entity: RenderEntity, state: GameState, view: ViewState, active: Set<string>, alpha: number, key: string) {
    const spriteName = spriteNameFor(entity);
    const rows = sprites[spriteName];
    if (!rows) return;
    const center = entityCenter(entity, view.camera);
    const px = worldPixel(view.camera.zoom || 1);
    const bounds = spriteBounds(rows);
    const texture = this.spriteTexture(spriteName, rows, entity.ownerId ? state.snapshot?.players[entity.ownerId]?.color : undefined);
    let sprite = this.entitySprites.get(key);
    if (!sprite) {
      sprite = new Sprite(texture);
      sprite.roundPixels = true;
      this.entitySprites.set(key, sprite);
      this.entityLayer.addChild(sprite);
    }
    const visualWidth = bounds.width * px;
    const x = Math.round(center.x - visualWidth / 2 - bounds.minX * px);
    const y = Math.round(spriteTopY(entity, center.y, bounds, px, view.camera.zoom || 1));
    const flip = "facing" in entity && entity.facing === "left";
    sprite.texture = texture;
    sprite.scale.set(flip ? -px : px, px);
    sprite.x = flip ? x + texture.width * px : x;
    sprite.y = y;
    sprite.alpha = alpha;
    sprite.visible = true;
    sprite.zIndex = (entity.x + entity.y) * 100 + (entity.kind === "unit" ? 2 : entity.kind === "building" ? 1 : 0);
    const flash = targetFlashFor(state, entity.id);
    sprite.tint = flash.amount > 0 && flash.color === "red" ? redTint(flash.amount) : 0xffffff;
    active.add(key);
    this.updateFlashOverlay(key, sprite, texture, flash, active);

    const ownerColor = entity.ownerId == null ? undefined : state.snapshot?.players[entity.ownerId]?.color;
    if (view.selectedIds.has(entity.id)) this.drawSelectionMarker(entity, view.camera, center.x, center.y, ownerColor || "#f4efe6");
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

  private updateFlashOverlay(key: string, base: Sprite, texture: Texture, flash: { amount: number; color: string }, active: Set<string>) {
    const fKey = `flash:${key}`;
    if (flash.amount <= 0 || flash.color === "red") {
      const existing = this.flashSprites.get(fKey);
      if (existing) existing.visible = false;
      return;
    }
    let overlay = this.flashSprites.get(fKey);
    if (!overlay) {
      overlay = new Sprite(texture);
      overlay.roundPixels = true;
      overlay.blendMode = BLEND_MODES.ADD;
      overlay.tint = 0xffffff;
      this.flashSprites.set(fKey, overlay);
      this.entityLayer.addChild(overlay);
    }
    overlay.texture = texture;
    overlay.scale.copyFrom(base.scale);
    overlay.x = base.x;
    overlay.y = base.y;
    overlay.alpha = base.alpha * Math.min(1, flash.amount);
    overlay.zIndex = base.zIndex + 0.5;
    overlay.visible = true;
    active.add(fKey);
  }

  private hideAllEntitySprites(active: Set<string>) {
    for (const [key, sprite] of this.entitySprites) sprite.visible = active.has(key);
    for (const [key, sprite] of this.flashSprites) sprite.visible = active.has(key);
  }

  private spriteTexture(spriteName: SpriteName, rows: readonly string[], playerColor: string | undefined) {
    const key = `${spriteName}:${playerColor || ""}`;
    const cached = this.textureCache.get(key);
    if (cached) return cached;
    const canvas = document.createElement("canvas");
    canvas.width = rows[0]?.length || 1;
    canvas.height = rows.length || 1;
    const ctx = canvas.getContext("2d")!;
    for (let py = 0; py < rows.length; py += 1) {
      const row = rows[py]!;
      for (let px = 0; px < row.length; px += 1) {
        const part = row[px]!;
        const color = part === "p" || part === "P" ? (playerColor || "#2f5d9a") : palette[part as keyof typeof palette];
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(px, py, 1, 1);
      }
    }
    const texture = Texture.from(canvas);
    texture.baseTexture.scaleMode = SCALE_MODES.NEAREST;
    this.textureCache.set(key, texture);
    return texture;
  }

  private drawEffects(state: GameState, view: ViewState) {
    const now = performance.now();
    for (const effect of state.effects || []) {
      const life = Math.max(0, Math.min(1, (now - effect.createdAt) / effect.duration));
      if (effect.type !== "moveCross") continue;
      const p = isoToScreen(effect.x, effect.y, view.camera);
      const alpha = 1 - life;
      const px = worldPixel(view.camera.zoom || 1);
      this.overlayLayer.beginFill(0xd83f34, alpha);
      const s = px * 2;
      this.overlayLayer.drawRect(Math.round(p.x - s / 2), Math.round(p.y - px * 5), s, px * 10);
      this.overlayLayer.drawRect(Math.round(p.x - px * 5), Math.round(p.y - s / 2), px * 10, s);
      this.overlayLayer.beginFill(0xffd2c9, alpha);
      this.overlayLayer.drawRect(Math.round(p.x - px / 2), Math.round(p.y - px / 2), px, px);
      this.overlayLayer.endFill();
    }
  }

  private drawSoundDebug(state: GameState, view: ViewState) {
    const sources = state.snapshot?.soundDebug;
    if (!sources?.length) return;
    for (const source of sources) {
      const center = isoToScreen(source.x, source.y, view.camera);
      const zoom = view.camera.zoom || 1;
      const rx = (source.range * TILE_W * zoom) / 2;
      const ry = (source.range * TILE_H * zoom) / 2;
      if (center.x + rx < -80 || center.x - rx > window.innerWidth + 80 || center.y + ry < -80 || center.y - ry > window.innerHeight + 80) continue;
      const color = soundColor(source);
      const alpha = Math.min(0.24, 0.06 + source.strength * 0.025);
      this.overlayLayer.lineStyle(Math.max(1, Math.round(2 * zoom)), color, Math.min(0.9, alpha * 3));
      this.overlayLayer.beginFill(color, alpha);
      this.overlayLayer.drawEllipse(center.x, center.y, rx, ry);
      this.overlayLayer.endFill();
      this.overlayLayer.lineStyle();
      this.overlayLayer.beginFill(color, 0.95);
      const dot = Math.max(3, Math.min(12, source.strength * 1.8)) * zoom;
      this.overlayLayer.drawCircle(center.x, center.y, dot);
      this.overlayLayer.endFill();
    }
  }

  private drawHealth(x: number, y: number, pct: number) {
    this.overlayLayer.beginFill(0x1b1715);
    this.overlayLayer.drawRect(x - 18, y, 36, 5);
    this.overlayLayer.beginFill(pct > 0.45 ? 0x5fbf64 : 0xd8714f);
    this.overlayLayer.drawRect(x - 17, y + 1, Math.max(1, 34 * pct), 3);
    this.overlayLayer.endFill();
  }

  private drawSelectionMarker(entity: RenderEntity, camera: CameraState, x: number, y: number, color: string) {
    if (entity.kind === "building" || entity.kind === "ruin") {
      this.drawPixelFootprint(entity.x, entity.y, entity.size || 1, camera, color);
      return;
    }
    const px = worldPixel(this.currentZoom || 1);
    const rx = Math.max(5, Math.round((entity.size || 0.8) * 8));
    const ry = Math.max(3, Math.round((entity.size || 0.8) * 4));
    this.drawPixelDiamond(x, y, rx, ry, px, hexToNumber(color));
  }

  private drawPixelFootprint(tileX: number, tileY: number, size: number, camera: CameraState, color: string) {
    const top = isoToScreen(tileX - 0.5, tileY - 0.5, camera);
    const right = isoToScreen(tileX + size - 0.5, tileY - 0.5, camera);
    const bottom = isoToScreen(tileX + size - 0.5, tileY + size - 0.5, camera);
    const left = isoToScreen(tileX - 0.5, tileY + size - 0.5, camera);
    const cx = (left.x + right.x) / 2;
    const cy = (top.y + bottom.y) / 2;
    const px = worldPixel(this.currentZoom || 1);
    const rx = Math.max(2, Math.round((right.x - left.x) / 2 / px));
    const ry = Math.max(1, Math.round((bottom.y - top.y) / 2 / px));
    this.drawPixelDiamond(cx, cy, rx, ry, px, hexToNumber(color));
  }

  private drawPixelDiamond(x: number, y: number, rx: number, ry: number, px: number, edge: number) {
    const g = this.selectionLayer;
    g.beginFill(0x111813, 0.9);
    for (let row = -ry; row <= ry; row += 1) {
      if (Math.abs(row) === ry) continue;
      const width = Math.round(rx * (1 - Math.abs(row) / (ry + 1)));
      for (let col = -width + 1; col <= width - 1; col += 1) g.drawRect(Math.round(x + col * px), Math.round(y + row * px), px, px);
    }
    g.endFill();
    g.beginFill(edge, 1);
    for (let row = -ry; row <= ry; row += 1) {
      const width = Math.round(rx * (1 - Math.abs(row) / (ry + 1)));
      if (Math.abs(row) === ry) {
        for (let col = -width; col <= width; col += 1) g.drawRect(Math.round(x + col * px), Math.round(y + row * px), px, px);
        continue;
      }
      g.drawRect(Math.round(x - width * px), Math.round(y + row * px), px, px);
      g.drawRect(Math.round(x + width * px), Math.round(y + row * px), px, px);
    }
    g.endFill();
  }

  private drawTeamAccent(entity: RenderEntity, centerX: number, topY: number, visualWidth: number, color: string | undefined) {
    if (!color || !entity.ownerId) return;
    const px = worldPixel(this.currentZoom || 1);
    this.overlayLayer.beginFill(hexToNumber(color));
    if (entity.kind === "building") this.overlayLayer.drawRect(Math.round(centerX - visualWidth * 0.18), Math.round(topY + px * 2), Math.max(px * 3, visualWidth * 0.16), px * 2);
    else if (entity.kind === "unit") this.overlayLayer.drawRect(Math.round(centerX - px * 3), Math.round(topY + px * 7), px * 5, px * 2);
    this.overlayLayer.endFill();
  }

  private drawAttackFlash(x: number, y: number, color: string) {
    this.overlayLayer.lineStyle(3, hexToNumber(color));
    this.overlayLayer.moveTo(x - 18, y - 26);
    this.overlayLayer.lineTo(x + 18, y - 8);
    this.overlayLayer.lineStyle();
  }

  private drawWorkFlash(x: number, y: number, facing: "left" | "right" = "right", resource: "wood" | "ore" | "food" = "wood") {
    const dir = facing === "left" ? -1 : 1;
    const t = Math.floor(performance.now() / 120) % 2;
    const swingY = t ? -38 : -30;
    this.overlayLayer.beginFill(resource === "ore" ? 0xc1b77b : resource === "food" ? 0x6fa04a : 0xe9bd59);
    this.overlayLayer.drawRect(Math.round(x + dir * 8), Math.round(y + swingY), 14 * dir, 4);
    this.overlayLayer.beginFill(resource === "ore" ? 0x687276 : 0x4b3728);
    this.overlayLayer.drawRect(Math.round(x + dir * 18), Math.round(y + swingY + 4), 8 * dir, 4);
    this.overlayLayer.endFill();
  }

  private drawCarryBadge(x: number, y: number, resource: "wood" | "ore" | "food") {
    this.overlayLayer.beginFill(resource === "wood" ? 0x8b623e : resource === "ore" ? 0xc1b77b : 0x6fa04a);
    this.overlayLayer.drawRect(x - 5, y, 10, 6);
    this.overlayLayer.beginFill(0x111813);
    this.overlayLayer.drawRect(x - 3, y + 4, 6, 2);
    this.overlayLayer.endFill();
  }

  private drawSelectionBox(view: ViewState) {
    if (!view.dragging || !view.dragCurrent || !view.dragStart) return;
    const x = Math.min(view.dragStart.x, view.dragCurrent.x);
    const y = Math.min(view.dragStart.y, view.dragCurrent.y);
    const w = Math.abs(view.dragCurrent.x - view.dragStart.x);
    const h = Math.abs(view.dragCurrent.y - view.dragStart.y);
    this.overlayLayer.lineStyle(1, 0xf4efe6, 1);
    this.overlayLayer.beginFill(0xf4efe6, 0.12);
    this.overlayLayer.drawRect(x, y, w, h);
    this.overlayLayer.endFill();
    this.overlayLayer.lineStyle();
  }

  private drawPlacement(view: ViewState, state: GameState) {
    const mode = view.buildMode;
    if (!mode || !view.hoverTile) return;
    const size = buildingSize(mode);
    const valid = canPlacePreview(state, mode, view.hoverTile.x, view.hoverTile.y);
    this.drawFootprint(view.hoverTile.x, view.hoverTile.y, size, view.camera, valid ? "#e9bd59" : "#d84b3e", valid ? "rgb(233 189 89 / 0.28)" : "rgb(216 75 62 / 0.28)", 2);
  }

  private drawFootprint(x: number, y: number, size: number, camera: CameraState, stroke: string, fill: string, lineWidth = 2) {
    const points = [
      isoToScreen(x - 0.5, y - 0.5, camera),
      isoToScreen(x + size - 0.5, y - 0.5, camera),
      isoToScreen(x + size - 0.5, y + size - 0.5, camera),
      isoToScreen(x - 0.5, y + size - 0.5, camera),
    ];
    this.overlayLayer.lineStyle(lineWidth, hexToNumber(stroke), 1);
    this.overlayLayer.beginFill(cssColorToNumber(fill), cssAlpha(fill));
    this.overlayLayer.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length; i += 1) this.overlayLayer.lineTo(points[i]!.x, points[i]!.y);
    this.overlayLayer.closePath();
    this.overlayLayer.endFill();
    this.overlayLayer.lineStyle();
  }

  private drawMinimap(state: GameState, view: ViewState) {
    const now = performance.now();
    if (now - this.lastMinimapDraw < 180) return;
    this.lastMinimapDraw = now;
    drawMinimapCanvas(state, view);
  }
}

function drawMinimapCanvas(state: GameState, view: ViewState) {
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
    ctx.fillStyle = player?.color || (unit.type === "zombie" ? "#416b38" : "#d8d0c0");
    ctx.fillRect(Math.round(p.x), Math.round(p.y), 2, 2);
  }
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

function redTint(amount: number) {
  const t = Math.min(1, amount * 0.9);
  const g = Math.round(255 + (66 - 255) * t);
  const b = Math.round(255 + (50 - 255) * t);
  return (255 << 16) | (g << 8) | b;
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

function spriteTopY(entity: RenderEntity, centerY: number, bounds: { maxY: number }, scale: number, zoom: number) {
  const footprintBottom = centerY + ((entity.size || 0) * TILE_H * zoom) / 2;
  return footprintBottom - (bounds.maxY + 1) * scale;
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

function soundColor(source: SoundDebugSource) {
  if (source.soundKind === "zombie") return 0x8a71d6;
  if (source.kind === "action") return 0xe9bd59;
  if (source.kind === "building") return 0x4da3ff;
  return 0x73d879;
}

function hexToNumber(color = "#ffffff") {
  if (!color.startsWith("#")) return 0xffffff;
  return Number.parseInt(color.slice(1), 16);
}

function cssColorToNumber(color: string) {
  if (color.startsWith("#")) return hexToNumber(color);
  if (color.includes("216 75 62")) return 0xd84b3e;
  if (color.includes("233 189 89")) return 0xe9bd59;
  return 0x111813;
}

function cssAlpha(color: string) {
  const match = /\/\s*([0-9.]+)/.exec(color);
  return match ? Number(match[1]) : 1;
}
