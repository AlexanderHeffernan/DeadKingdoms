import {
	Application,
	BLEND_MODES,
	Container,
	Graphics,
	SCALE_MODES,
	Sprite,
	Texture,
} from "pixi.js";
import { SCALE, TILE_H, TILE_W } from "./constants.js";
import { BUILDING_DEFS } from "../../src/shared/buildingRegistry.js";
import { isoToScreen } from "./iso.js";
import { palette } from "./sprites/palette.js";
import { sprites } from "./sprites/index.js";
import { pngSprites } from "./sprites/pngSprites.js";
import { spriteMetrics } from "./sprites/spriteInfo.js";
import grassLightTileUrl from "./sprites/grass_tile_light.png";
import grassDarkTileUrl from "./sprites/grass_tile_dark.png";
import type {
	Building,
	ResourceNode,
	ResourceType,
	Ruin,
	SoundDebugSource,
	SpriteName,
	Unit,
} from "../../src/shared/types.js";
import type {
	CameraState,
	ClientSnapshot,
	Effect,
	GameState,
	ViewState,
} from "./clientTypes.js";

type RenderEntity = Unit | Building | ResourceNode | Ruin;

export class Renderer {
	canvas: HTMLCanvasElement;
	app: Application;
	background: Graphics;
	terrainLayer: Container;
	selectionLayer: Graphics;
	selectionSpriteLayer: Container;
	entityLayer: Container;
	overlayLayer: Graphics;
	currentZoom: number;

	private tilePool: Sprite[] = [];
	private selectionSprites: Sprite[] = [];
	private activeSelectionSprites = 0;
	private entitySprites = new Map<string, Sprite>();
	private flashSprites = new Map<string, Sprite>();
	private textureCache = new Map<string, Texture>();
	private tileTextureCache = new Map<string, Texture>();
	private lastMinimapDraw = 0;
	private grassLightImage = new Image();
	private grassLightReady = false;

	private grassDarkImage = new Image();
	private grassDarkReady = false;

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
		this.selectionSpriteLayer = new Container();
		this.entityLayer = new Container();
		this.entityLayer.sortableChildren = true;
		this.overlayLayer = new Graphics();
		this.app.stage.addChild(
			this.background,
			this.terrainLayer,
			this.selectionLayer,
			this.selectionSpriteLayer,
			this.entityLayer,
			this.overlayLayer,
		);
		this.currentZoom = 1;
		this.grassLightImage.onload = () => {
			this.grassLightReady = true;
			this.tileTextureCache.clear();
		};
		this.grassLightImage.src = grassLightTileUrl;
		this.grassDarkImage.onload = () => {
			this.grassDarkReady = true;
			this.tileTextureCache.clear();
		};
		this.grassDarkImage.src = grassDarkTileUrl;
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
		this.activeSelectionSprites = 0;
		if (!state.snapshot) {
			this.hideAllEntitySprites(new Set());
			this.hideUnusedTiles(0);
			this.app.render();
			return;
		}

		this.drawTiles(
			state.snapshot.map.size,
			view.camera,
			state.snapshot.visibility,
		);
		const active = new Set<string>();
		this.drawLastSeen(state, view, active);
		this.drawEntities(state, view, active);
		this.hideAllEntitySprites(active);
		this.hideUnusedSelectionSprites();
		this.drawPathDebug(state, view);
		this.drawSoundDebug(state, view);
		this.drawZombieDebug(state, view);
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

	private drawTiles(
		size: number,
		camera: CameraState,
		visibility: ClientSnapshot["visibility"],
	) {
		const exploredSet = visibility?.exploredSet;
		const visibleSet = visibility?.visibleSet;
		const bounds = visibleTileBounds(size, camera);
		let index = 0;
		for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
			for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
				const key = y * size + x;
				if (visibility && !exploredSet?.has(key)) continue;
				const screen = isoToScreen(x, y, camera);
				if (
					screen.x < -90 ||
						screen.x > window.innerWidth + 90 ||
						screen.y < -60 ||
						screen.y > window.innerHeight + 60
				)
					continue;
				const visible = !visibility || (visibleSet?.has(key) ?? false);
				const color = visible ? null : "#1e3025";
				const tile = this.tileAt(index++);
				tile.texture = this.tileTexture(visible, (y % 2) + (x % 2) == 1);
				const overdraw = 0.75;
				tile.scale.set(
					this.currentZoom + overdraw / tile.texture.width,
					this.currentZoom + overdraw / tile.texture.height,
				);
				tile.x = screen.x;
				tile.y = screen.y;
				tile.visible = true;
			}
		}
		this.hideUnusedTiles(index);
	}

	private tileAt(index: number) {
		let tile = this.tilePool[index];
		if (!tile) {
			tile = new Sprite();
			tile.anchor.set(0.5);
			this.tilePool[index] = tile;
			this.terrainLayer.addChild(tile);
		}
		return tile;
	}

	private hideUnusedTiles(start: number) {
		for (let i = start; i < this.tilePool.length; i += 1)
		this.tilePool[i]!.visible = false;
	}

	private tileTexture(visible: boolean, isDark: boolean) {
		const key = isDark
			? `grassDark:${visible ? 1 : 0}`
			: `grassLight:${visible ? 1 : 0}`;

		const cached = this.tileTextureCache.get(key);
		if (cached) return cached;

		// The canvas must be exactly one tile so that, when drawTiles centres the
		// texture on isoToScreen(x, y), the grass diamond's centre lands on that
		// point too. Using an oversized canvas with the diamond in the top-left
		// quadrant shifted every tile half a tile up-left of where entities,
		// selection markers, and hit-testing place it.
		const canvas = document.createElement("canvas");
		canvas.width = TILE_W;
		canvas.height = TILE_H;

		const ctx = canvas.getContext("2d")!;
		ctx.imageSmoothingEnabled = false;

		const grassImage = isDark ? this.grassDarkImage : this.grassLightImage;

		ctx.drawImage(grassImage, 0, 0, TILE_W, TILE_H);

		if (!visible) {
			ctx.save();

			// Only affect existing non-transparent pixels
			ctx.globalCompositeOperation = "source-atop";

			// Darken the visible grass pixels
			ctx.fillStyle = "rgba(10, 16, 12, 0.62)";
			ctx.fillRect(0, 0, TILE_W, TILE_H);

			ctx.restore();
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
		for (const entity of entities)
		this.updateEntitySprite(entity, state, view, active, 1, entity.id);
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
			...Object.values(state.lastSeen.ruins).map((ruin) => ({
				...ruin,
				sprite: "ruin",
			})),
		].filter(
			(entity) =>
				!visibleIds.has(entity.id) &&
					isExplored(
						state.snapshot!.visibility,
						entity.x,
						entity.y,
						entity.size || 1,
						mapSize,
					) &&
					isEntityNearViewport(entity, view.camera),
		);
		for (const entity of remembered)
		this.updateEntitySprite(
			entity,
			state,
			view,
			active,
			0.35,
			`last:${entity.id}`,
		);
	}

	private updateEntitySprite(
		entity: RenderEntity,
		state: GameState,
		view: ViewState,
		active: Set<string>,
		alpha: number,
		key: string,
	) {
		const spriteName = spriteNameFor(entity);
		const png = pngSprites[spriteName];
		if (!png && !sprites[spriteName]) return;
		const center = entityCenter(entity, view.camera);
		const px = worldPixel(view.camera.zoom || 1);
		const bounds = spriteMetrics(spriteName);
		const ownerColor =
			entity.ownerId == null
				? undefined
				: state.snapshot?.players[entity.ownerId]?.color;
		const visualWidth = bounds.width * px;
		const x = center.x - visualWidth / 2 - bounds.minX * px;
		const y = spriteTopY(entity, center.y, bounds, px, view.camera.zoom || 1);
		const flip = "facing" in entity && entity.facing === "left";
		const baseZ =
			(entity.x + entity.y) * 100 +
				(entity.kind === "unit" ? 2 : entity.kind === "building" ? 1 : 0);
		const flash = targetFlashFor(state, entity.id);
		const flashTint =
			flash.amount > 0 && flash.color === "red"
				? redTint(flash.amount)
				: 0xffffff;

		let texture: Texture;
		if (png) {
			// Flag layer underneath, tinted to the owner's colour (the source art is
			// white so a multiplicative tint recolours it directly).
			const flagKey = `flagLayer:${key}`;
			if (png.flag) {
				const flagTexture = this.pngTexture(png.flag);
				const flag = this.placeSprite(
					flagKey,
					flagTexture,
					x,
					y,
					px,
					flip,
					alpha,
					baseZ - 0.5,
				);
				flag.tint = ownerColor ? hexToNumber(ownerColor) : 0xffffff;
				active.add(flagKey);
			} else {
				const existingFlag = this.entitySprites.get(flagKey);
				if (existingFlag) existingFlag.visible = false;
			}
			texture = this.pngTexture(png.base);
			const sprite = this.placeSprite(
				key,
				texture,
				x,
				y,
				px,
				flip,
				alpha,
				baseZ,
			);
			sprite.tint = flashTint;
		} else {
			texture = this.spriteTexture(
				spriteName,
				sprites[spriteName]!,
				ownerColor,
			);
			const sprite = this.placeSprite(
				key,
				texture,
				x,
				y,
				px,
				flip,
				alpha,
				baseZ,
			);
			sprite.tint = flashTint;
		}
		active.add(key);
			this.updateFlashOverlay(
				key,
				this.entitySprites.get(key)!,
				texture,
				flash,
				active,
			);
			this.drawZombieHordeTint(entity, x, y, bounds.width * px, bounds.height * px);

		if (view.selectedIds.has(entity.id))
			this.drawSelectionMarker(
				entity,
				view.camera,
				center.x,
				center.y,
				ownerColor || "#f4efe6",
			);
		if ("attackFlash" in entity && entity.attackFlash > 0)
			this.drawAttackFlash(center.x, center.y, ownerColor || "#f4efe6");
		if (entity.kind === "unit") {
			const cmd = entity.command as { resourceKind?: ResourceType };
			if (entity.workFlash > 0)
				this.drawWorkFlash(
					center.x,
					center.y,
					entity.facing,
					cmd.resourceKind || entity.carried?.resource,
				);
			if (entity.carried?.amount)
				this.drawCarryBadge(center.x, y - 2, entity.carried.resource);
		}
		if ("hp" in entity && entity.hp && entity.maxHp && entity.hp < entity.maxHp)
			this.drawHealth(center.x, y - 8, entity.hp / entity.maxHp);
		if (
			entity.kind === "building" &&
				entity.gatherResource() &&
				entity.maxAmount &&
				entity.amount! < entity.maxAmount
		)
			this.drawHealth(center.x, y - 8, (entity.amount || 0) / entity.maxAmount);
		if (
			entity.kind === "resource" &&
				entity.maxAmount &&
				entity.amount < entity.maxAmount
		)
			this.drawHealth(center.x, y - 5, entity.amount / entity.maxAmount);
	}

	private updateFlashOverlay(
		key: string,
		base: Sprite,
		texture: Texture,
		flash: { amount: number; color: string },
		active: Set<string>,
	) {
		const fKey = `flash:${key}`;
		if (flash.amount <= 0 || flash.color === "red") {
			const existing = this.flashSprites.get(fKey);
			if (existing) existing.visible = false;
			return;
		}
		let overlay = this.flashSprites.get(fKey);
		if (!overlay) {
			overlay = new Sprite(texture);
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
		for (const [key, sprite] of this.entitySprites)
		sprite.visible = active.has(key);
			for (const [key, sprite] of this.flashSprites)
			sprite.visible = active.has(key);
		}

	private placeSprite(
		key: string,
		texture: Texture,
		x: number,
		y: number,
		px: number,
		flip: boolean,
		alpha: number,
		zIndex: number,
	) {
		let sprite = this.entitySprites.get(key);
		if (!sprite) {
			sprite = new Sprite(texture);
			this.entitySprites.set(key, sprite);
			this.entityLayer.addChild(sprite);
		}
		sprite.texture = texture;
		sprite.scale.set(flip ? -px : px, px);
		sprite.x = flip ? x + texture.width * px : x;
		sprite.y = y;
		sprite.alpha = alpha;
		sprite.tint = 0xffffff;
		sprite.visible = true;
		sprite.zIndex = zIndex;
		return sprite;
	}

	private pngTexture(url: string) {
		const cached = this.textureCache.get(url);
		if (cached) return cached;
		const texture = Texture.from(url);
		texture.baseTexture.scaleMode = SCALE_MODES.NEAREST;
		this.textureCache.set(url, texture);
		return texture;
	}

	private spriteTexture(
		spriteName: SpriteName,
		rows: readonly string[],
		playerColor: string | undefined,
	) {
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
				const color =
					part === "p" || part === "P"
						? playerColor || "#2f5d9a"
						: palette[part as keyof typeof palette];
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
			const life = Math.max(
				0,
				Math.min(1, (now - effect.createdAt) / effect.duration),
			);
			if (effect.type !== "moveCross") continue;
			const p = isoToScreen(effect.x, effect.y, view.camera);
			const alpha = 1 - life;
			const px = worldPixel(view.camera.zoom || 1);
			this.overlayLayer.beginFill(0xd83f34, alpha);
			const s = px * 2;
			this.overlayLayer.drawRect(
				Math.round(p.x - s / 2),
				Math.round(p.y - px * 5),
				s,
				px * 10,
			);
			this.overlayLayer.drawRect(
				Math.round(p.x - px * 5),
				Math.round(p.y - s / 2),
				px * 10,
				s,
			);
			this.overlayLayer.beginFill(0xffd2c9, alpha);
			this.overlayLayer.drawRect(
				Math.round(p.x - px / 2),
				Math.round(p.y - px / 2),
				px,
				px,
			);
			this.overlayLayer.endFill();
		}
	}

	private drawSoundDebug(state: GameState, view: ViewState) {
		const sources = state.snapshot?.soundDebug;
		if (!sources?.length) return;
		for (const source of sources) {
			if (source.kind === "field" && source.cellX !== undefined && source.cellY !== undefined && source.cellSize) {
				this.drawSoundDebugCell(source, view);
				continue;
			}
			const center = isoToScreen(source.x, source.y, view.camera);
			const zoom = view.camera.zoom || 1;
			const rx = (source.range * TILE_W * zoom) / 2;
			const ry = (source.range * TILE_H * zoom) / 2;
			if (
				center.x + rx < -80 ||
					center.x - rx > window.innerWidth + 80 ||
					center.y + ry < -80 ||
					center.y - ry > window.innerHeight + 80
			)
				continue;
			const color = soundColor(source);
			const alpha = Math.min(0.24, 0.06 + source.strength * 0.025);
			this.overlayLayer.lineStyle(
				Math.max(1, Math.round(2 * zoom)),
				color,
				Math.min(0.9, alpha * 3),
			);
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

	private drawSoundDebugCell(source: SoundDebugSource, view: ViewState) {
		const cellSize = source.cellSize || 1;
		const x = (source.cellX || 0) * cellSize;
		const y = (source.cellY || 0) * cellSize;
		const top = isoToScreen(x, y, view.camera);
		const right = isoToScreen(x + cellSize, y, view.camera);
		const bottom = isoToScreen(x + cellSize, y + cellSize, view.camera);
		const left = isoToScreen(x, y + cellSize, view.camera);
		const minX = Math.min(top.x, right.x, bottom.x, left.x);
		const maxX = Math.max(top.x, right.x, bottom.x, left.x);
		const minY = Math.min(top.y, right.y, bottom.y, left.y);
		const maxY = Math.max(top.y, right.y, bottom.y, left.y);
		if (maxX < -80 || minX > window.innerWidth + 80 || maxY < -80 || minY > window.innerHeight + 80) return;
		const color = soundColor(source);
		const intensity = Math.min(1, source.strength / 12);
		const alpha = 0.08 + intensity * 0.28;
		const zoom = view.camera.zoom || 1;
		this.overlayLayer.lineStyle(Math.max(1, Math.round(1.5 * zoom)), color, source.overflow ? 0.9 : 0.55);
		this.overlayLayer.beginFill(color, alpha);
		this.overlayLayer.moveTo(top.x, top.y);
		this.overlayLayer.lineTo(right.x, right.y);
		this.overlayLayer.lineTo(bottom.x, bottom.y);
		this.overlayLayer.lineTo(left.x, left.y);
		this.overlayLayer.lineTo(top.x, top.y);
		this.overlayLayer.endFill();
	}

	private drawPathDebug(state: GameState, view: ViewState) {
		if (!state.snapshot?.pathDebug) return;
		const zoom = view.camera.zoom || 1;
		const lineWidth = Math.max(1, Math.round(2 * zoom));
		for (const unit of Object.values(state.snapshot.units)) {
			if (unit.ownerId !== state.playerId || !state.selectedIds.has(unit.id)) continue;
			const path = unit.command?.path;
			if (!path?.length) continue;
			this.overlayLayer.lineStyle(lineWidth, 0x4fd8c8, 0.42);
			const start = isoToScreen(unit.x, unit.y, view.camera);
			this.overlayLayer.moveTo(start.x, start.y);
			for (const point of path) {
				const screen = isoToScreen(point.x, point.y, view.camera);
				this.overlayLayer.lineTo(screen.x, screen.y);
			}
			const end = isoToScreen(path[path.length - 1]!.x, path[path.length - 1]!.y, view.camera);
			this.overlayLayer.lineStyle();
			this.overlayLayer.beginFill(0x4fd8c8, 0.75);
			this.overlayLayer.drawCircle(end.x, end.y, Math.max(2, 3 * zoom));
			this.overlayLayer.endFill();
		}
		this.overlayLayer.lineStyle();
	}

		private drawZombieDebug(state: GameState, view: ViewState) {
			const zombies = Object.values(state.snapshot?.units || {}).filter((unit) => unit.type === "zombie" && unit.zombieDebugState);
			if (!zombies.length) return;
		const zoom = view.camera.zoom || 1;
		const radius = Math.max(3, Math.round(5 * zoom));
		this.overlayLayer.lineStyle(Math.max(1, Math.round(1.5 * zoom)), 0x101612, 0.85);
		for (const zombie of zombies) {
			const point = isoToScreen(zombie.x, zombie.y, view.camera);
			if (point.x < -30 || point.x > window.innerWidth + 30 || point.y < -40 || point.y > window.innerHeight + 30) continue;
			this.overlayLayer.beginFill(zombieDebugColor(zombie.zombieDebugState!), 0.9);
			this.overlayLayer.drawCircle(point.x, point.y - Math.max(10, 18 * zoom), radius);
			this.overlayLayer.endFill();
		}
			this.overlayLayer.lineStyle();
		}

		private drawZombieHordeTint(entity: RenderEntity, x: number, y: number, width: number, height: number) {
			if (entity.kind !== "unit" || entity.type !== "zombie" || !entity.zombieHordeColor) return;
			this.overlayLayer.lineStyle(0);
			this.overlayLayer.beginFill(hexToNumber(entity.zombieHordeColor), 0.48);
			this.overlayLayer.drawRect(x, y, width, height);
			this.overlayLayer.endFill();
		}

		private drawHealth(x: number, y: number, pct: number) {
		this.overlayLayer.beginFill(0x1b1715);
		this.overlayLayer.drawRect(x - 18, y, 36, 5);
		this.overlayLayer.beginFill(pct > 0.45 ? 0x5fbf64 : 0xd8714f);
		this.overlayLayer.drawRect(x - 17, y + 1, Math.max(1, 34 * pct), 3);
		this.overlayLayer.endFill();
	}

	private drawSelectionMarker(
		entity: RenderEntity,
		camera: CameraState,
		x: number,
		y: number,
		color: string,
	) {
		if (entity.kind === "building" || entity.kind === "ruin") {
			this.drawPixelFootprint(
				entity.x,
				entity.y,
				entity.size || 1,
				camera,
				color,
			);
			return;
		}
		const px = worldPixel(this.currentZoom || 1);
		const rx = Math.max(5, Math.round((entity.size || 0.8) * 8));
		const ry = Math.max(3, Math.round((entity.size || 0.8) * 4));
		this.placeSelectionDiamond(x, y, rx, ry, px, hexToNumber(color));
	}

	private placeSelectionDiamond(
		x: number,
		y: number,
		rx: number,
		ry: number,
		px: number,
		edge: number,
	) {
		const sprite = this.selectionSpriteAt(this.activeSelectionSprites++);
		sprite.texture = this.selectionDiamondTexture(rx, ry, edge);
		sprite.scale.set(px);
		sprite.x = Math.round(x - rx * px);
		sprite.y = Math.round(y - ry * px);
		sprite.visible = true;
	}

	private selectionSpriteAt(index: number) {
		let sprite = this.selectionSprites[index];
		if (!sprite) {
			sprite = new Sprite();
			this.selectionSprites[index] = sprite;
			this.selectionSpriteLayer.addChild(sprite);
		}
		return sprite;
	}

	private hideUnusedSelectionSprites() {
		for (let i = this.activeSelectionSprites; i < this.selectionSprites.length; i += 1)
			this.selectionSprites[i]!.visible = false;
	}

	private selectionDiamondTexture(rx: number, ry: number, edge: number) {
		const key = `selection:${rx}:${ry}:${edge}`;
		const cached = this.textureCache.get(key);
		if (cached) return cached;
		const canvas = document.createElement("canvas");
		canvas.width = rx * 2 + 1;
		canvas.height = ry * 2 + 1;
		const ctx = canvas.getContext("2d")!;
		ctx.fillStyle = "#111813";
		ctx.globalAlpha = 0.9;
		for (let row = -ry; row <= ry; row += 1) {
			if (Math.abs(row) === ry) continue;
			const width = Math.round(rx * (1 - Math.abs(row) / (ry + 1)));
			for (let col = -width + 1; col <= width - 1; col += 1)
				ctx.fillRect(rx + col, ry + row, 1, 1);
		}
		ctx.globalAlpha = 1;
		ctx.fillStyle = numberToHex(edge);
		for (let row = -ry; row <= ry; row += 1) {
			const width = Math.round(rx * (1 - Math.abs(row) / (ry + 1)));
			if (Math.abs(row) === ry) {
				for (let col = -width; col <= width; col += 1)
					ctx.fillRect(rx + col, ry + row, 1, 1);
				continue;
			}
			ctx.fillRect(rx - width, ry + row, 1, 1);
			ctx.fillRect(rx + width, ry + row, 1, 1);
		}
		const texture = Texture.from(canvas);
		texture.baseTexture.scaleMode = SCALE_MODES.NEAREST;
		this.textureCache.set(key, texture);
		return texture;
	}

	private drawPixelFootprint(
		tileX: number,
		tileY: number,
		size: number,
		camera: CameraState,
		color: string,
	) {
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

	private drawPixelDiamond(
		x: number,
		y: number,
		rx: number,
		ry: number,
		px: number,
		edge: number,
	) {
		const g = this.selectionLayer;
		g.beginFill(0x111813, 0.9);
		for (let row = -ry; row <= ry; row += 1) {
			if (Math.abs(row) === ry) continue;
			const width = Math.round(rx * (1 - Math.abs(row) / (ry + 1)));
			for (let col = -width + 1; col <= width - 1; col += 1)
			g.drawRect(Math.round(x + col * px), Math.round(y + row * px), px, px);
		}
		g.endFill();
		g.beginFill(edge, 1);
		for (let row = -ry; row <= ry; row += 1) {
			const width = Math.round(rx * (1 - Math.abs(row) / (ry + 1)));
			if (Math.abs(row) === ry) {
				for (let col = -width; col <= width; col += 1)
				g.drawRect(
					Math.round(x + col * px),
					Math.round(y + row * px),
					px,
					px,
				);
				continue;
			}
			g.drawRect(Math.round(x - width * px), Math.round(y + row * px), px, px);
			g.drawRect(Math.round(x + width * px), Math.round(y + row * px), px, px);
		}
		g.endFill();
	}

	private drawAttackFlash(x: number, y: number, color: string) {
		this.overlayLayer.lineStyle(3, hexToNumber(color));
		this.overlayLayer.moveTo(x - 18, y - 26);
		this.overlayLayer.lineTo(x + 18, y - 8);
		this.overlayLayer.lineStyle();
	}

	private drawWorkFlash(
		x: number,
		y: number,
		facing: "left" | "right" = "right",
		resource: "wood" | "ore" | "food" = "wood",
	) {
		const dir = facing === "left" ? -1 : 1;
		const t = Math.floor(performance.now() / 120) % 2;
		const swingY = t ? -38 : -30;
		this.overlayLayer.beginFill(
			resource === "ore" ? 0xc1b77b : resource === "food" ? 0x6fa04a : 0xe9bd59,
		);
		this.overlayLayer.drawRect(
			Math.round(x + dir * 8),
			Math.round(y + swingY),
			14 * dir,
			4,
		);
		this.overlayLayer.beginFill(resource === "ore" ? 0x687276 : 0x4b3728);
		this.overlayLayer.drawRect(
			Math.round(x + dir * 18),
			Math.round(y + swingY + 4),
			8 * dir,
			4,
		);
		this.overlayLayer.endFill();
	}

	private drawCarryBadge(
		x: number,
		y: number,
		resource: "wood" | "ore" | "food",
	) {
		this.overlayLayer.beginFill(
			resource === "wood" ? 0x8b623e : resource === "ore" ? 0xc1b77b : 0x6fa04a,
		);
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
		const valid = canPlacePreview(
			state,
			mode,
			view.hoverTile.x,
			view.hoverTile.y,
		);
		const ownerColor =
			(state.playerId && state.snapshot?.players[state.playerId]?.color) ||
				"#f4efe6";
		this.drawPixelFootprint(
			view.hoverTile.x,
			view.hoverTile.y,
			size,
			view.camera,
			valid ? ownerColor : "#d84b3e",
		);
		this.drawPlacementPreviewSprite(
			mode as SpriteName,
			view.hoverTile.x,
			view.hoverTile.y,
			size,
			view.camera,
			ownerColor,
			valid,
		);
	}

	private drawPlacementPreviewSprite(
		spriteName: SpriteName,
		x: number,
		y: number,
		size: number,
		camera: CameraState,
		ownerColor: string,
		valid: boolean,
	) {
		const png = pngSprites[spriteName];
		if (!png && !sprites[spriteName]) return;
		const center = footprintCenter(x, y, size, camera);
		const px = worldPixel(camera.zoom || 1);
		const bounds = spriteMetrics(spriteName);
		const visualWidth = bounds.width * px;
		const spriteX = center.x - visualWidth / 2 - bounds.minX * px;
		const topY = spriteTopY(
			{ kind: "building", type: spriteName, x, y, size } as Building,
			center.y,
			bounds,
			px,
			camera.zoom || 1,
		);
		const alpha = valid ? 0.42 : 0.28;
		const zIndex = (x + y) * 100 + 0.75;
		const tint = valid ? 0xffffff : 0xffb3aa;

		if (png) {
			const flagKey = "placementPreview:flag";
			if (png.flag) {
				const flag = this.placeSprite(
					flagKey,
					this.pngTexture(png.flag),
					spriteX,
					topY,
					px,
					false,
					alpha,
					zIndex - 0.5,
				);
				flag.tint = hexToNumber(ownerColor);
			} else {
				const existingFlag = this.entitySprites.get(flagKey);
				if (existingFlag) existingFlag.visible = false;
			}
			const sprite = this.placeSprite(
				"placementPreview",
				this.pngTexture(png.base),
				spriteX,
				topY,
				px,
				false,
				alpha,
				zIndex,
			);
			sprite.tint = tint;
			return;
		}

		const sprite = this.placeSprite(
			"placementPreview",
			this.spriteTexture(spriteName, sprites[spriteName]!, ownerColor),
			spriteX,
			topY,
			px,
			false,
			alpha,
			zIndex,
		);
		sprite.tint = tint;
	}

	private drawMinimap(state: GameState, view: ViewState) {
		const now = performance.now();
		if (now - this.lastMinimapDraw < 180) return;
		this.lastMinimapDraw = now;
		drawMinimapCanvas(state, view);
	}
}

function drawMinimapCanvas(state: GameState, view: ViewState) {
	const minimap = document.getElementById(
		"minimap",
	) as HTMLCanvasElement | null;
	if (!minimap || !state.snapshot) return;
	const ctx = minimap.getContext("2d")!;
	const size = state.snapshot.map.size;
	const project = (x: number, y: number) =>
		minimapIsoToScreen(x, y, size, minimap.width, minimap.height);
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
		const p = project(
			building.x + (building.size - 1) / 2,
			building.y + (building.size - 1) / 2,
		);
		ctx.fillStyle = player?.color || "#d8d0c0";
		ctx.fillRect(
			Math.round(p.x - 2),
			Math.round(p.y - 2),
			Math.max(3, building.size + 2),
			Math.max(3, building.size + 2),
		);
	}
	for (const unit of Object.values(state.snapshot.units)) {
		const player = state.snapshot.players[unit.ownerId];
		const p = project(unit.x, unit.y);
		ctx.fillStyle =
			player?.color || (unit.type === "zombie" ? "#416b38" : "#d8d0c0");
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
		if (
			entity.type === "tree" ||
				entity.type === "ore" ||
				entity.type === "stump" ||
				entity.type === "berry"
		)
			return entity.type;
	}
	return entity.type as SpriteName;
}

function targetFlashFor(state: GameState, id: string) {
	const effect = (state.effects || []).find(
		(item): item is Extract<Effect, { type: "targetFlash" }> =>
			item.type === "targetFlash" && item.targetId === id,
	);
	if (!effect) return { amount: 0, color: "white" };
	return {
		amount: Math.max(
			0,
			1 - (performance.now() - effect.createdAt) / effect.duration,
		),
		color: effect.color || "white",
	};
}

function redTint(amount: number) {
	const t = Math.min(1, amount * 0.9);
	const g = Math.round(255 + (66 - 255) * t);
	const b = Math.round(255 + (50 - 255) * t);
	return (255 << 16) | (g << 8) | b;
}

function buildingSize(type: string) {
	if (type in BUILDING_DEFS)
		return BUILDING_DEFS[type as keyof typeof BUILDING_DEFS].stats.size;
	if (type === "townCenter") return 4;
	if (type === "barracks") return 3;
	if (type === "house") return 2;
	if (
		type === "watchTower" ||
			type === "lumberCamp" ||
			type === "foodDepot" ||
			type === "miningCamp"
	)
		return 1;
	return 1;
}

function canPlacePreview(
	state: GameState,
	buildingType: string,
	x: number,
	y: number,
) {
	if (!state.snapshot) return false;
	const size = buildingSize(buildingType);
	const player = state.snapshot.players[state.playerId!];
	const cost = buildingCost(buildingType);
	if (
		!Object.entries(cost).every(
			([resource, amount]) =>
				(player?.resources?.[resource as ResourceType] || 0) >=
					(amount as number),
		)
	)
		return false;
	if (
		x < 0 ||
			y < 0 ||
			x + size > state.snapshot.map.size ||
			y + size > state.snapshot.map.size
	)
		return false;
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
	return type in BUILDING_DEFS
		? BUILDING_DEFS[type as keyof typeof BUILDING_DEFS].stats.cost
		: {};
}

function rectsOverlap(
	a: { x: number; y: number; size: number },
	b: { x: number; y: number; size: number },
) {
	return (
		a.x < b.x + b.size &&
			a.x + a.size > b.x &&
			a.y < b.y + b.size &&
			a.y + a.size > b.y
	);
}

function entityCenter(entity: RenderEntity, camera: CameraState) {
	if (entity.kind === "building" || entity.kind === "ruin" || entity.kind === "resource")
		return footprintCenter(entity.x, entity.y, entity.size || 1, camera);
	return isoToScreen(
		entity.x + (entity.size || 0) / 2,
		entity.y + (entity.size || 0) / 2,
		camera,
	);
}

function isEntityNearViewport(entity: RenderEntity, camera: CameraState) {
	const size = entity.size || 1;
	const p = entity.kind === "unit"
		? isoToScreen(entity.x + size / 2, entity.y + size / 2, camera)
		: footprintCenter(entity.x, entity.y, size, camera);
	const margin = 260;
	return (
		p.x >= -margin &&
			p.x <= window.innerWidth + margin &&
			p.y >= -margin &&
			p.y <= window.innerHeight + margin
	);
}

function footprintCenter(
	x: number,
	y: number,
	size: number,
	camera: CameraState,
) {
	return isoToScreen(x + (size - 1) / 2, y + (size - 1) / 2, camera);
}

function spriteTopY(
	entity: RenderEntity,
	centerY: number,
	bounds: { maxY: number },
	scale: number,
	zoom: number,
) {
	// Units stand at a point (their feet rest on the tile centre), while
	// resources occupy a 1-tile footprint like buildings, so their base should
	// sit at the bottom of the tile rather than the centre.
	const footprintSize =
		entity.kind === "unit" ? entity.size || 0 : entity.size || 1;
	const footprintBottom = centerY + (footprintSize * TILE_H * zoom) / 2;
	return footprintBottom - (bounds.maxY + 1) * scale;
}

function isExplored(
	visibility: ClientSnapshot["visibility"],
	x: number,
	y: number,
	size: number,
	mapSize: number,
) {
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
		screenToIsoLocal(
			window.innerWidth + margin,
			window.innerHeight + margin,
			camera,
		),
		screenToIsoLocal(-margin, window.innerHeight + margin, camera),
	];
	return {
		minX: clampInt(
			Math.floor(Math.min(...corners.map((point) => point.x))) - 3,
			0,
			size - 1,
		),
		maxX: clampInt(
			Math.ceil(Math.max(...corners.map((point) => point.x))) + 3,
			0,
			size - 1,
		),
		minY: clampInt(
			Math.floor(Math.min(...corners.map((point) => point.y))) - 3,
			0,
			size - 1,
		),
		maxY: clampInt(
			Math.ceil(Math.max(...corners.map((point) => point.y))) + 3,
			0,
			size - 1,
		),
	};
}

function clampInt(value: number, min: number, max: number) {
	return Math.max(min, Math.min(max, value));
}

function minimapIsoToScreen(
	x: number,
	y: number,
	size: number,
	width: number,
	height: number,
) {
	const usableW = width - 12;
	const usableH = height - 12;
	return {
		x: width / 2 + ((x - y) / size) * (usableW / 2),
		y: height / 2 + ((x + y - size) / size) * (usableH / 2),
	};
}

function worldPixel(zoom: number) {
	return SCALE * zoom;
}

function soundColor(source: SoundDebugSource) {
	if (source.soundKind === "zombie") return 0x8a71d6;
	if (source.kind === "field") return source.overflow ? 0xf06f47 : 0x73d879;
	if (source.kind === "action") return 0xe9bd59;
	if (source.kind === "building") return 0x4da3ff;
	return 0x73d879;
}

function zombieDebugColor(state: Unit["zombieDebugState"]) {
	switch (state) {
		case "sound": return 0x2ee86f;
		case "pathing": return 0x4aa3ff;
		case "stuck": return 0xff3434;
		case "wander": return 0xf3d34a;
		case "aggro": return 0xff8b2f;
		case "blocked": return 0xd66cff;
		case "idle": return 0xd8d0c0;
		default: return 0xffffff;
	}
}

function hexToNumber(color = "#ffffff") {
	if (!color.startsWith("#")) return 0xffffff;
	return Number.parseInt(color.slice(1), 16);
}

function numberToHex(color: number) {
	return `#${color.toString(16).padStart(6, "0")}`;
}
