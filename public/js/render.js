import { SCALE, TILE_H, TILE_W } from "./constants.js";
import { isoToScreen } from "./iso.js";
import { palette } from "./sprites/palette.js";
import { sprites } from "./sprites/index.js";
import { spriteBounds } from "./spriteBounds.js";

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
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;
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

  draw(state, view) {
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
    ].sort((a, b) => (a.x + a.y) - (b.x + b.y));

    for (const entity of entities) this.drawEntity(entity, state, view);
    this.drawPlacement(view, state);
    this.drawSelectionBox(view);
    this.drawMinimap(state, view);
  }

  drawTiles(size, camera, visibility) {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const key = `${x},${y}`;
        if (visibility && !visibility.explored.includes(key)) continue;
        const screen = isoToScreen(x, y, camera);
        if (screen.x < -80 || screen.x > window.innerWidth + 80 || screen.y < -50 || screen.y > window.innerHeight + 80) continue;
        const visible = !visibility || visibility.visible.includes(key);
        const color = visible ? tileColors[(x + y) % tileColors.length] : "#1e3025";
        this.drawTile(screen.x, screen.y, color, visible);
      }
    }
  }

  drawTile(cx, cy, color, visible) {
    const px = worldPixel(this.currentZoom || 1);
    const startX = Math.round(cx - 8 * px);
    const startY = Math.round(cy - 4 * px);
    for (let y = 0; y < GROUND_TILE.length; y += 1) {
      for (let x = 0; x < GROUND_TILE[y].length; x += 1) {
        const key = GROUND_TILE[y][x];
        if (key === ".") continue;
        this.ctx.fillStyle = visible ? shade(color, key === "a" ? 1.06 : 0.88) : color;
        this.ctx.fillRect(startX + x * px, startY + y * px, px, px);
      }
    }
  }

  drawEntity(entity, state, view) {
    const type = entity.sprite || entity.type;
    const spriteName = type === "tree" || type === "ore" || type === "stump" ? type : spriteNameFor(entity);
    const rows = sprites[spriteName];
    if (!rows) return;
    const center = isoToScreen(entity.x + (entity.size || 0) / 2, entity.y + (entity.size || 0) / 2, view.camera);
    const scale = entityScale(entity, view.camera.zoom || 1);
    const bounds = spriteBounds(rows);
    const visualWidth = bounds.width * scale;
    const visualHeight = bounds.height * scale;
    const x = Math.round(center.x - visualWidth / 2 - bounds.minX * scale);
    const y = Math.round(isFlatFootprint(entity) ? center.y - visualHeight / 2 - bounds.minY * scale : center.y - (bounds.maxY + 1) * scale);
    if (view.selectedIds.has(entity.id)) this.drawSelectionMarker(center.x, center.y, entity.size || 0.8, state.snapshot.players[entity.ownerId]?.color || "#f4efe6");
    this.drawSprite(rows, x, y, state.snapshot.players[entity.ownerId]?.color, entity.facing === "left", scale);
    this.drawTeamAccent(entity, center.x, y, visualWidth, state.snapshot.players[entity.ownerId]?.color);
    if (entity.attackFlash > 0) this.drawAttackFlash(center.x, center.y, state.snapshot.players[entity.ownerId]?.color || "#f4efe6");
    if (entity.workFlash > 0) this.drawWorkFlash(center.x, center.y, entity.facing);
    if (entity.carried?.amount) this.drawCarryBadge(center.x, y - 2, entity.carried.resource);
    if (entity.hp && entity.maxHp && entity.hp < entity.maxHp) this.drawHealth(center.x, y - 8, entity.hp / entity.maxHp);
    if (entity.type === "farm" && entity.maxAmount && entity.amount < entity.maxAmount) this.drawHealth(center.x, y - 8, (entity.amount || 0) / entity.maxAmount);
    if (entity.kind === "resource" && entity.maxAmount && entity.amount < entity.maxAmount) this.drawHealth(center.x, y - 5, entity.amount / entity.maxAmount);
  }

  drawSprite(rows, x, y, playerColor, flip = false, scale = SCALE) {
    const { ctx } = this;
    if (flip) {
      ctx.save();
      ctx.translate(x + rows[0].length * scale, y);
      ctx.scale(-1, 1);
      x = 0;
      y = 0;
    }
    for (let py = 0; py < rows.length; py += 1) {
      for (let px = 0; px < rows[py].length; px += 1) {
        const key = rows[py][px];
        const color = key === "p" || key === "P" ? (key === "P" ? lighten(playerColor) : playerColor) : palette[key];
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(x + px * scale, y + py * scale, scale, scale);
      }
    }
    if (flip) ctx.restore();
  }

  drawCarryBadge(x, y, resource) {
    const { ctx } = this;
    ctx.fillStyle = resource === "wood" ? "#8b623e" : resource === "ore" ? "#c1b77b" : "#6fa04a";
    ctx.fillRect(x - 5, y, 10, 6);
    ctx.fillStyle = "#111813";
    ctx.fillRect(x - 3, y + 4, 6, 2);
  }

  drawAttackFlash(x, y, color) {
    const { ctx } = this;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x - 18, y - 26);
    ctx.lineTo(x + 18, y - 8);
    ctx.stroke();
  }

  drawWorkFlash(x, y, facing = "right") {
    const { ctx } = this;
    const dir = facing === "left" ? -1 : 1;
    ctx.fillStyle = "#e9bd59";
    ctx.fillRect(Math.round(x + dir * 8), Math.round(y - 34), 14 * dir, 4);
    ctx.fillStyle = "#4b3728";
    ctx.fillRect(Math.round(x + dir * 18), Math.round(y - 30), 8 * dir, 4);
  }

  drawHealth(x, y, pct) {
    const { ctx } = this;
    ctx.fillStyle = "#1b1715";
    ctx.fillRect(x - 18, y, 36, 5);
    ctx.fillStyle = pct > 0.45 ? "#5fbf64" : "#d8714f";
    ctx.fillRect(x - 17, y + 1, Math.max(1, 34 * pct), 3);
  }

  drawSelectionMarker(x, y, size, color) {
    const zoom = this.currentZoom || 1;
    const px = worldPixel(zoom);
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

  drawTeamAccent(entity, centerX, topY, visualWidth, color) {
    if (!color || !entity.ownerId) return;
    const px = worldPixel(this.currentZoom || 1);
    const { ctx } = this;
    if (entity.kind === "building") {
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(centerX - visualWidth * 0.18), Math.round(topY + px * 2), Math.max(px * 3, visualWidth * 0.16), px * 2);
      ctx.fillStyle = "#f4efe6";
      ctx.fillRect(Math.round(centerX - visualWidth * 0.18), Math.round(topY + px * 2), px, px);
    } else if (entity.kind === "unit" && entity.type === "villager") {
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(centerX - px * 3), Math.round(topY + px * 7), px * 5, px * 2);
    }
  }

  drawSelectionBox(view) {
    if (!view.dragging || !view.dragCurrent) return;
    const { ctx } = this;
    const x = Math.min(view.dragStart.x, view.dragCurrent.x);
    const y = Math.min(view.dragStart.y, view.dragCurrent.y);
    const w = Math.abs(view.dragCurrent.x - view.dragStart.x);
    const h = Math.abs(view.dragCurrent.y - view.dragStart.y);
    ctx.strokeStyle = "#f4efe6";
    ctx.fillStyle = "rgb(244 239 230 / 0.12)";
    ctx.strokeRect(x, y, w, h);
    ctx.fillRect(x, y, w, h);
  }

  drawPlacement(view, state) {
    if (!view.buildMode) return;
    const { ctx } = this;
    const tile = view.hoverTile;
    if (!tile) return;
    const size = view.buildMode === "house" || view.buildMode === "farm" || view.buildMode === "watchTower" || view.buildMode === "lumberCamp" || view.buildMode === "miningCamp" ? 1 : 2;
    for (let yy = 0; yy < size; yy += 1) {
      for (let xx = 0; xx < size; xx += 1) {
        const p = isoToScreen(tile.x + xx, tile.y + yy, view.camera);
        ctx.globalAlpha = 0.55;
        this.drawTile(p.x, p.y, "#e9bd59", true);
        ctx.globalAlpha = 1;
      }
    }
    const rows = sprites[view.buildMode];
    if (rows) {
      const center = isoToScreen(tile.x + size / 2, tile.y + size / 2, view.camera);
      const scale = entityScale({ kind: "building", type: view.buildMode, size }, view.camera.zoom || 1);
      const bounds = spriteBounds(rows);
      const visualWidth = bounds.width * scale;
      const visualHeight = bounds.height * scale;
      ctx.globalAlpha = 0.72;
      const y = view.buildMode === "farm" ? center.y - visualHeight / 2 - bounds.minY * scale : center.y - (bounds.maxY + 1) * scale;
      this.drawSprite(rows, Math.round(center.x - visualWidth / 2 - bounds.minX * scale), Math.round(y), state.snapshot?.players[state.playerId]?.color, false, scale);
      ctx.globalAlpha = 1;
    }
  }

  drawLastSeen(state, view) {
    if (!state.snapshot?.visibility) return;
    const visibleIds = new Set([
      ...Object.keys(state.snapshot.buildings),
      ...Object.keys(state.snapshot.resources),
      ...Object.keys(state.snapshot.ruins),
    ]);
    const remembered = [
      ...Object.values(state.lastSeen.buildings),
      ...Object.values(state.lastSeen.resources),
      ...Object.values(state.lastSeen.ruins).map((ruin) => ({ ...ruin, sprite: "ruin" })),
    ].filter((entity) => !visibleIds.has(entity.id) && isExplored(state.snapshot.visibility, entity.x, entity.y, entity.size || 1));
    this.ctx.globalAlpha = 0.35;
    for (const entity of remembered.sort((a, b) => (a.x + a.y) - (b.x + b.y))) this.drawEntity(entity, state, view);
    this.ctx.globalAlpha = 1;
  }

  drawMinimap(state, view) {
    const minimap = document.getElementById("minimap");
    if (!minimap || !state.snapshot) return;
    const ctx = minimap.getContext("2d");
    const size = state.snapshot.map.size;
    const project = (x, y) => minimapIsoToScreen(x, y, size, minimap.width, minimap.height);
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

    const explored = new Set(state.snapshot.visibility?.explored || []);
    const visible = new Set(state.snapshot.visibility?.visible || []);
    for (const key of explored) {
      const [x, y] = key.split(",").map(Number);
      const p = project(x + 0.5, y + 0.5);
      ctx.fillStyle = visible.has(key) ? "#356743" : "#223629";
      ctx.fillRect(Math.round(p.x), Math.round(p.y), 2, 2);
    }
    for (const building of Object.values(state.snapshot.buildings)) {
      const player = state.snapshot.players[building.ownerId];
      const p = project(building.x + building.size / 2, building.y + building.size / 2);
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

  drawMinimapViewport(ctx, state, view, project) {
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

function spriteNameFor(entity) {
  if (entity.kind === "ruin") return "ruin";
  return entity.type;
}

function lighten(color = "#ffffff") {
  return color;
}

function entityScale(entity, zoom) {
  return worldPixel(zoom);
}

function isFlatFootprint(entity) {
  return entity.type === "farm";
}

function shade(hex, factor) {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * factor)));
  const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * factor)));
  const b = Math.max(0, Math.min(255, Math.round((n & 255) * factor)));
  return `rgb(${r} ${g} ${b})`;
}

function isExplored(visibility, x, y, size) {
  const explored = new Set(visibility.explored || []);
  for (let yy = Math.floor(y); yy < Math.ceil(y + size); yy += 1) {
    for (let xx = Math.floor(x); xx < Math.ceil(x + size); xx += 1) {
      if (explored.has(`${xx},${yy}`)) return true;
    }
  }
  return false;
}

function screenToIsoLocal(x, y, camera) {
  const zoom = camera.zoom || 1;
  const sx = (x - camera.x) / zoom;
  const sy = (y - camera.y) / zoom;
  return {
    x: sy / TILE_H + sx / TILE_W,
    y: sy / TILE_H - sx / TILE_W,
  };
}

function minimapIsoToScreen(x, y, size, width, height) {
  const usableW = width - 12;
  const usableH = height - 12;
  return {
    x: width / 2 + ((x - y) / size) * (usableW / 2),
    y: height / 2 + ((x + y - size) / size) * (usableH / 2),
  };
}

function worldPixel(zoom) {
  return Math.max(2, Math.round(SCALE * zoom));
}
