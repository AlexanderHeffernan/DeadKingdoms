import {
	Application,
	BLEND_MODES,
	Container,
	Graphics,
	SCALE_MODES,
	Sprite,
	Texture,
} from "pixi.js";
import { DayNightVisuals } from "./dayNightVisuals.js";
import { SCALE, TILE_H, TILE_W } from "./constants.js";
import { BUILDING_TYPES } from "../../src/shared/buildings/index.js";
import { isoToScreen } from "./iso.js";
import { palette } from "./sprites/palette.js";
import { sprites } from "./sprites/index.js";
import { pngSprites } from "./sprites/pngSprites.js";
import { spriteMetrics } from "./sprites/spriteInfo.js";
import grassLightTileUrl from "./sprites/grass_tile_light.png";
import grassDarkTileUrl from "./sprites/grass_tile_dark.png";
import type {
	Building,
	Corpse,
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

type RenderEntity = Unit | Building | ResourceNode | Ruin | Corpse;
type Footprint = { x: number; y: number; size?: number; width?: number; height?: number };
type SpriteAlphaMask = { width: number; height: number; alpha: Uint8ClampedArray };
type RenderedSpriteRect = {
	left: number;
	right: number;
	top: number;
	bottom: number;
	width: number;
	height: number;
};
type RenderedAlphaMask = { rect: RenderedSpriteRect; mask: SpriteAlphaMask; flipped: boolean };

const UNIT_OCCLUSION_OUTLINE_THRESHOLD = 0.8;

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
	private alphaMaskCache = new Map<string, SpriteAlphaMask | null>();
	private dayNightVisuals: DayNightVisuals;
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
		this.dayNightVisuals = new DayNightVisuals();
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
			this.dayNightVisuals.hide();
			this.hideUnusedTiles(0);
			this.app.render();
			return;
		}

		this.dayNightVisuals.draw(state.snapshot, view);
		this.drawTiles(
			state.snapshot.map.size,
			view.camera,
			state.snapshot.visibility,
		);
		const active = new Set<string>();
		this.drawLastSeen(state, view, active);
		this.drawEntities(state, view, active);
		this.drawFrontSelectedUnitMarkers(state, view, active);
		this.drawFrontSelectedUnitSprites(state, view, active);
		this.drawOccludedUnitOutlines(state, view, active);
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
				tile.tint = this.dayNightVisuals.tileTint(x, y, visible);
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
			...Object.values(snap.corpses),
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
		const spriteName = spriteNameFor(entity, state);
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
		const baseZ = renderDepth(entity) * 100 + renderLayerOffset(entity);
		const flash = targetFlashFor(state, entity.id);
		const flashTint =
			flash.amount > 0 && flash.color === "red"
				? redTint(flash.amount)
				: 0xffffff;
		const entityTint = this.dayNightVisuals.entityTint(entity);

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
				flag.tint = ownerColor ? multiplyTint(hexToNumber(ownerColor), entityTint) : entityTint;
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
			sprite.tint = flashTint === 0xffffff ? entityTint : flashTint;
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
			sprite.tint = flashTint === 0xffffff ? entityTint : flashTint;
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
		if ("attackFlash" in entity && (entity.attackFlash ?? 0) > 0)
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
				entity.gatherResource &&
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

	private drawOccludedUnitOutlines(state: GameState, view: ViewState, active: Set<string>) {
		const snap = state.snapshot;
		if (!snap) return;
		const blockers = [
			...Object.values(snap.resources),
			...Object.values(snap.buildings),
		].filter((entity) => isEntityNearViewport(entity, view.camera));
		for (const unit of Object.values(snap.units)) {
			if (!isEntityNearViewport(unit, view.camera)) continue;
			if (!this.isUnitOccluded(unit, blockers, view)) continue;
			this.drawUnitOutline(unit, state, view, active);
		}
	}

	private drawFrontSelectedUnitMarkers(state: GameState, view: ViewState, active: Set<string>) {
		const snap = state.snapshot;
		if (!snap) return;
		for (const id of view.selectedIds) {
			const unit = snap.units[id];
			if (!unit || !isEntityNearViewport(unit, view.camera)) continue;
			this.drawFrontUnitSelectionMarker(unit, state, view, active);
		}
	}

	private drawFrontSelectedUnitSprites(state: GameState, view: ViewState, active: Set<string>) {
		const snap = state.snapshot;
		if (!snap) return;
		const blockers = [
			...Object.values(snap.resources),
			...Object.values(snap.buildings),
		].filter((entity) => isEntityNearViewport(entity, view.camera));
		for (const id of view.selectedIds) {
			const unit = snap.units[id];
			if (!unit || !isEntityNearViewport(unit, view.camera)) continue;
			if (this.isUnitOccluded(unit, blockers, view)) continue;
			this.drawFrontUnitSprite(unit, state, view, active);
		}
	}

	private isUnitOccluded(unit: Unit, blockers: (Building | ResourceNode)[], view: ViewState) {
		const unitRect = renderedSpriteRect(unit, view.camera, null);
		const unitMask = this.alphaMaskFor(spriteNameFor(unit, { snapshot: null } as GameState));
		if (!unitMask) return false;
		const unitDepth = renderDepth(unit);
		const blockerMasks = blockers.flatMap((blocker): RenderedAlphaMask[] => {
			if (renderDepth(blocker) <= unitDepth) return [];
			const blockerSprite = spriteNameFor(blocker, { snapshot: null } as GameState);
			const blockerMask = this.alphaMaskFor(blockerSprite);
			if (!blockerMask) return [];
			const blockerRect = renderedSpriteRect(blocker, view.camera, null);
			if (!rectsIntersect(unitRect, blockerRect)) return [];
			return [{ rect: blockerRect, mask: blockerMask, flipped: false }];
		});
		return unitOpaqueCoverage(unitRect, unitMask, unit.facing === "left", blockerMasks) >= UNIT_OCCLUSION_OUTLINE_THRESHOLD;
	}

	private drawUnitOutline(unit: Unit, state: GameState, view: ViewState, active: Set<string>) {
		const spriteName = spriteNameFor(unit, state);
		const png = pngSprites[spriteName];
		if (!png) return;
		const playerColor = state.snapshot?.players[unit.ownerId]?.color || "#f4efe6";
		const color = state.selectedIds.has(unit.id) ? playerColor : darkenHex(playerColor, 0.55);
		const center = entityCenter(unit, view.camera);
		const px = worldPixel(view.camera.zoom || 1);
		const bounds = spriteMetrics(spriteName);
		const visualWidth = bounds.width * px;
		const x = center.x - visualWidth / 2 - bounds.minX * px;
		const y = spriteTopY(unit, center.y, bounds, px, view.camera.zoom || 1);
		const texture = this.unitOutlineTexture(png.base, color);
		if (texture === Texture.EMPTY) return;
		const key = `unitOutline:${unit.id}`;
		const sprite = this.placeSprite(
			key,
			texture,
			x,
			y,
			px,
			unit.facing === "left",
			1,
			999000 + renderDepth(unit),
		);
		sprite.tint = 0xffffff;
		active.add(key);
	}

	private drawFrontUnitSprite(unit: Unit, state: GameState, view: ViewState, active: Set<string>) {
		const spriteName = spriteNameFor(unit, state);
		const png = pngSprites[spriteName];
		if (!png && !sprites[spriteName]) return;
		const ownerColor = state.snapshot?.players[unit.ownerId]?.color;
		const center = entityCenter(unit, view.camera);
		const px = worldPixel(view.camera.zoom || 1);
		const bounds = spriteMetrics(spriteName);
		const visualWidth = bounds.width * px;
		const x = center.x - visualWidth / 2 - bounds.minX * px;
		const y = spriteTopY(unit, center.y, bounds, px, view.camera.zoom || 1);
		const flip = unit.facing === "left";
		const baseZ = 998500 + renderDepth(unit);
		const flash = targetFlashFor(state, unit.id);
		const flashTint =
			flash.amount > 0 && flash.color === "red"
				? redTint(flash.amount)
				: 0xffffff;
		const unitTint = this.dayNightVisuals.entityTint(unit);

		if (png) {
			const flagKey = `frontSelectedFlag:${unit.id}`;
			if (png.flag) {
				const flag = this.placeSprite(
					flagKey,
					this.pngTexture(png.flag),
					x,
					y,
					px,
					flip,
					1,
					baseZ - 0.5,
				);
				flag.tint = ownerColor ? multiplyTint(hexToNumber(ownerColor), unitTint) : unitTint;
				active.add(flagKey);
			}
			const key = `frontSelectedUnit:${unit.id}`;
			const sprite = this.placeSprite(
				key,
				this.pngTexture(png.base),
				x,
				y,
				px,
				flip,
				1,
				baseZ,
			);
			sprite.tint = flashTint === 0xffffff ? unitTint : flashTint;
			active.add(key);
			return;
		}

		const key = `frontSelectedUnit:${unit.id}`;
		const sprite = this.placeSprite(
			key,
			this.spriteTexture(spriteName, sprites[spriteName]!, ownerColor),
			x,
			y,
			px,
			flip,
			1,
			baseZ,
		);
		sprite.tint = flashTint === 0xffffff ? unitTint : flashTint;
		active.add(key);
	}

	private drawFrontUnitSelectionMarker(unit: Unit, state: GameState, view: ViewState, active: Set<string>) {
		const color = state.snapshot?.players[unit.ownerId]?.color || "#f4efe6";
		const center = entityCenter(unit, view.camera);
		const px = worldPixel(view.camera.zoom || 1);
		const rx = Math.max(5, Math.round((unit.size || 0.8) * 8));
		const ry = Math.max(3, Math.round((unit.size || 0.8) * 4));
		const texture = this.selectionDiamondTexture(rx, ry, hexToNumber(color));
		const key = `frontSelection:${unit.id}`;
		const sprite = this.placeSprite(
			key,
			texture,
			Math.round(center.x - rx * px),
			Math.round(center.y - ry * px),
			px,
			false,
			1,
			998000 + renderDepth(unit),
		);
		sprite.tint = 0xffffff;
		active.add(key);
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

	private unitOutlineTexture(url: string, playerColor: string) {
		const key = `unitOutline:${url}:${playerColor}`;
		const cached = this.textureCache.get(key);
		if (cached) return cached;

		const image = new Image();
		image.onload = () => this.textureCache.delete(key);
		image.src = url;
		if (!image.complete || image.naturalWidth <= 0) return Texture.EMPTY;

		const canvas = document.createElement("canvas");
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		const ctx = canvas.getContext("2d")!;
		ctx.imageSmoothingEnabled = false;

		const source = document.createElement("canvas");
		source.width = image.naturalWidth;
		source.height = image.naturalHeight;
		const sourceCtx = source.getContext("2d")!;
		sourceCtx.imageSmoothingEnabled = false;
		sourceCtx.drawImage(image, 0, 0);
		const data = sourceCtx.getImageData(0, 0, source.width, source.height);
		const mask = ctx.createImageData(canvas.width, canvas.height);
		const edgeColor = rgbForHex(playerColor);
		const innerColor = darkenRgb(edgeColor, 0.55);
		for (let y = 0; y < source.height; y += 1) {
			for (let x = 0; x < source.width; x += 1) {
				const color = isInnerEdgePixel(data, x, y)
					? edgeColor
					: isSecondInnerEdgePixel(data, x, y)
						? innerColor
						: null;
				if (!color) continue;
				const index = (y * source.width + x) * 4;
				mask.data[index] = color.r;
				mask.data[index + 1] = color.g;
				mask.data[index + 2] = color.b;
				mask.data[index + 3] = 255;
			}
		}
		ctx.putImageData(mask, 0, 0);

		const texture = Texture.from(canvas);
		texture.baseTexture.scaleMode = SCALE_MODES.NEAREST;
		this.textureCache.set(key, texture);
		return texture;
	}

	private alphaMaskFor(spriteName: SpriteName) {
		const png = pngSprites[spriteName];
		if (png) return this.pngAlphaMask(png.base);
		return asciiAlphaMask(spriteName, sprites[spriteName] || sprites.house);
	}

	private pngAlphaMask(url: string) {
		const cached = this.alphaMaskCache.get(url);
		if (cached !== undefined) return cached;

		const image = new Image();
		image.onload = () => this.alphaMaskCache.delete(url);
		image.src = url;
		if (!image.complete || image.naturalWidth <= 0) {
			this.alphaMaskCache.set(url, null);
			return null;
		}

		const canvas = document.createElement("canvas");
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		const ctx = canvas.getContext("2d")!;
		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(image, 0, 0);
		const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
		const alpha = new Uint8ClampedArray(canvas.width * canvas.height);
		for (let index = 0; index < alpha.length; index += 1)
			alpha[index] = imageData.data[index * 4 + 3] || 0;
		const mask = { width: canvas.width, height: canvas.height, alpha };
		this.alphaMaskCache.set(url, mask);
		return mask;
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
			const alpha = 1 - life;
			this.drawMoveCross(effect.x, effect.y, view, alpha);
		}
		for (const id of state.selectedIds) {
			const building = state.snapshot?.buildings[id];
			if (!building?.rallyPoint) continue;
			this.drawMoveCross(building.rallyPoint.x, building.rallyPoint.y, view, 0.9);
		}
	}

	private drawMoveCross(x: number, y: number, view: ViewState, alpha: number) {
		const p = isoToScreen(x, y, view.camera);
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
				entityWidth(entity),
				entityHeight(entity),
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
		width: number,
		height: number,
		camera: CameraState,
		color: string,
	) {
		const top = isoToScreen(tileX - 0.5, tileY - 0.5, camera);
		const right = isoToScreen(tileX + width - 0.5, tileY - 0.5, camera);
		const bottom = isoToScreen(tileX + width - 0.5, tileY + height - 0.5, camera);
		const left = isoToScreen(tileX - 0.5, tileY + height - 0.5, camera);
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
		if (!view.dragging || !view.dragCurrent || !view.dragStart || view.buildMode) return;
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
		const valid = canPlacePreview(
			state,
			mode,
			view.hoverTile.x,
			view.hoverTile.y,
		);
		const ownerColor =
			(state.playerId && state.snapshot?.players[state.playerId]?.color) ||
				"#f4efe6";
		if (mode === "wall" && view.wallDragStartTile) {
			const tiles = wallLineTiles(view.wallDragStartTile, view.hoverTile);
			const lineValid = canAffordLine(state, "wall", tiles) && tiles.every((tile) => canPlacePreview(state, "wall", tile.x, tile.y));
			for (let index = 0; index < tiles.length; index += 1) {
				const tile = tiles[index]!;
				this.drawPixelFootprint(tile.x, tile.y, 1, 1, view.camera, lineValid ? ownerColor : "#d84b3e");
				this.drawPlacementPreviewSprite(
					wallPreviewSpriteName(tiles, index),
					tile.x,
					tile.y,
					1,
					1,
					view.camera,
					ownerColor,
					lineValid,
					`placementPreview:wall:${index}`,
				);
			}
			return;
		}
		const footprint = buildingFootprint(mode);
		this.drawPixelFootprint(view.hoverTile.x, view.hoverTile.y, footprint.width, footprint.height, view.camera, valid ? ownerColor : "#d84b3e");
		this.drawPlacementPreviewSprite(
			mode as SpriteName,
			view.hoverTile.x,
			view.hoverTile.y,
			footprint.width,
			footprint.height,
			view.camera,
			ownerColor,
			valid,
			"placementPreview",
		);
	}

	private drawPlacementPreviewSprite(
		spriteName: SpriteName,
		x: number,
		y: number,
		width: number,
		height: number,
		camera: CameraState,
		ownerColor: string,
		valid: boolean,
		key: string,
	) {
		const png = pngSprites[spriteName];
		if (!png && !sprites[spriteName]) return;
		const center = footprintCenter(x, y, width, height, camera);
		const px = worldPixel(camera.zoom || 1);
		const bounds = spriteMetrics(spriteName);
		const visualWidth = bounds.width * px;
		const spriteX = center.x - visualWidth / 2 - bounds.minX * px;
		const topY = spriteTopY(
			{ kind: "building", type: spriteName, x, y, size: Math.max(width, height), width, height } as Building,
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
				key,
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
			key,
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
			building.x + (entityWidth(building) - 1) / 2,
			building.y + (entityHeight(building) - 1) / 2,
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

function spriteNameFor(entity: RenderEntity, state: GameState): SpriteName {
	if (entity.kind === "ruin") return "ruin";
	if (entity.kind === "corpse") return "corpse";
	if (entity.kind === "unit" && entity.sprite) return entity.sprite;
	if (entity.kind === "resource") {
		if (
			entity.type === "tree" ||
				entity.type === "ore" ||
				entity.type === "stump" ||
				entity.type === "berry"
		)
			return entity.type;
	}
	if (entity.kind === "building" && entity.type === "wall") return wallSpriteName(entity, state);
	return entity.type as SpriteName;
}

function wallSpriteName(wall: Building, state: GameState): SpriteName {
	const hasWest = hasWallAt(state, wall, wall.x - 1, wall.y);
	const hasEast = hasWallAt(state, wall, wall.x + 1, wall.y);
	const hasNorth = hasWallAt(state, wall, wall.x, wall.y - 1);
	const hasSouth = hasWallAt(state, wall, wall.x, wall.y + 1);
	if (hasWest && hasEast) return "wallNorthEast";
	if (hasNorth && hasSouth) return "wallSouthEast";
	return "wallPillar";
}

function hasWallAt(state: GameState, wall: Building, x: number, y: number) {
	return Object.values(state.snapshot?.buildings || {}).some((building) => (
		building.type === "wall" &&
			building.ownerId === wall.ownerId &&
			building.x === x &&
			building.y === y
	));
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

function multiplyTint(a: number, b: number) {
	const ar = (a >> 16) & 0xff;
	const ag = (a >> 8) & 0xff;
	const ab = a & 0xff;
	const br = (b >> 16) & 0xff;
	const bg = (b >> 8) & 0xff;
	const bb = b & 0xff;
	return (Math.round((ar * br) / 255) << 16) |
		(Math.round((ag * bg) / 255) << 8) |
		Math.round((ab * bb) / 255);
}

function buildingSize(type: string) {
	if (type in BUILDING_TYPES)
		return BUILDING_TYPES[type as keyof typeof BUILDING_TYPES].size;
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

function buildingFootprint(type: string): { width: number; height: number } {
	if (type in BUILDING_TYPES) {
		const def = BUILDING_TYPES[type as keyof typeof BUILDING_TYPES];
		return {
			width: ("width" in def ? def.width : def.size) as number,
			height: ("height" in def ? def.height : def.size) as number,
		};
	}
	const size = buildingSize(type);
	return { width: size, height: size };
}

function canPlacePreview(
	state: GameState,
	buildingType: string,
	x: number,
	y: number,
) {
	if (!state.snapshot) return false;
	const footprint = buildingFootprint(buildingType);
	const player = state.snapshot.players[state.playerId!];
	const replacementWall = ownWallAt(state, x, y);
	const cost = effectiveBuildCost(state, buildingType, x, y);
	if (buildingType === "wall" && replacementWall) return true;
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
			x + footprint.width > state.snapshot.map.size ||
			y + footprint.height > state.snapshot.map.size
	)
		return false;
	for (const building of Object.values(state.snapshot.buildings)) {
		if (buildingType === "gate" && replacementWall && building.id === replacementWall.id) continue;
		if (rectsOverlap({ x, y, ...footprint }, building)) return false;
	}
	for (const resource of Object.values(state.snapshot.resources)) {
		const px = Math.floor(resource.x);
		const py = Math.floor(resource.y);
		if (px >= x && px < x + footprint.width && py >= y && py < y + footprint.height) return false;
	}
	return true;
}

function buildingCost(type: string) {
	return type in BUILDING_TYPES
		? BUILDING_TYPES[type as keyof typeof BUILDING_TYPES].cost
		: {};
}

function effectiveBuildCost(state: GameState, buildingType: string, x: number, y: number) {
	const cost = { ...buildingCost(buildingType) } as Partial<Record<ResourceType, number>>;
	const wall = ownWallAt(state, x, y);
	if (buildingType !== "gate" || !wall || wall.completed) return cost;
	for (const [resource, amount] of Object.entries(BUILDING_TYPES.wall.cost) as [ResourceType, number][]) {
		cost[resource] = Math.max(0, (cost[resource] || 0) - amount);
	}
	return cost;
}

function ownWallAt(state: GameState, x: number, y: number) {
	return Object.values(state.snapshot?.buildings || {}).find((building) => (
		building.ownerId === state.playerId &&
		building.type === "wall" &&
		building.x === x &&
		building.y === y
	)) || null;
}

function rectsOverlap(
	a: Footprint,
	b: Footprint,
) {
	const aw = entityWidth(a);
	const ah = entityHeight(a);
	const bw = entityWidth(b);
	const bh = entityHeight(b);
	return (
		a.x < b.x + bw &&
			a.x + aw > b.x &&
			a.y < b.y + bh &&
			a.y + ah > b.y
	);
}

function entityCenter(entity: RenderEntity, camera: CameraState) {
	if (entity.kind === "building" || entity.kind === "ruin" || entity.kind === "resource" || entity.kind === "corpse")
		return footprintCenter(entity.x, entity.y, entityWidth(entity), entityHeight(entity), camera);
	return isoToScreen(
		entity.x + (entity.size || 0) / 2,
		entity.y + (entity.size || 0) / 2,
		camera,
	);
}

function isEntityNearViewport(entity: RenderEntity, camera: CameraState) {
	const p = entity.kind === "unit"
		? isoToScreen(entity.x + entityWidth(entity) / 2, entity.y + entityHeight(entity) / 2, camera)
		: footprintCenter(entity.x, entity.y, entityWidth(entity), entityHeight(entity), camera);
	const margin = 260;
	return (
		p.x >= -margin &&
			p.x <= window.innerWidth + margin &&
			p.y >= -margin &&
			p.y <= window.innerHeight + margin
	);
}

function renderedSpriteRect(entity: RenderEntity, camera: CameraState, state: GameState | null) {
	const spriteName = spriteNameFor(entity, state || ({ snapshot: null } as GameState));
	const bounds = spriteMetrics(spriteName);
	const scale = worldPixel(camera.zoom || 1);
	const center = entityCenter(entity, camera);
	const visualWidth = bounds.width * scale;
	const visualHeight = bounds.height * scale;
	const left = center.x - visualWidth / 2 - bounds.minX * scale;
	const top = spriteTopY(entity, center.y, bounds, scale, camera.zoom || 1);
	return {
		left,
		right: left + visualWidth,
		top,
		bottom: top + visualHeight,
		width: visualWidth,
		height: visualHeight,
	};
}

function rectsIntersect(
	a: { left: number; right: number; top: number; bottom: number },
	b: { left: number; right: number; top: number; bottom: number },
) {
	return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function isInnerEdgePixel(data: ImageData, x: number, y: number) {
	if (alphaAt(data, x, y) === 0) return false;
	return (
		alphaAt(data, x - 1, y) === 0 ||
		alphaAt(data, x + 1, y) === 0 ||
		alphaAt(data, x, y - 1) === 0 ||
		alphaAt(data, x, y + 1) === 0
	);
}

function isSecondInnerEdgePixel(data: ImageData, x: number, y: number) {
	if (alphaAt(data, x, y) === 0 || isInnerEdgePixel(data, x, y)) return false;
	return (
		isInnerEdgePixel(data, x - 1, y) ||
		isInnerEdgePixel(data, x + 1, y) ||
		isInnerEdgePixel(data, x, y - 1) ||
		isInnerEdgePixel(data, x, y + 1)
	);
}

function alphaAt(data: ImageData, x: number, y: number) {
	if (x < 0 || y < 0 || x >= data.width || y >= data.height) return 0;
	return data.data[(y * data.width + x) * 4 + 3] || 0;
}

function rgbForHex(color: string) {
	const value = hexToNumber(color);
	return {
		r: (value >> 16) & 0xff,
		g: (value >> 8) & 0xff,
		b: value & 0xff,
	};
}

function darkenRgb(color: { r: number; g: number; b: number }, amount: number) {
	return {
		r: Math.round(color.r * amount),
		g: Math.round(color.g * amount),
		b: Math.round(color.b * amount),
	};
}

function darkenHex(color: string, amount: number) {
	const dark = darkenRgb(rgbForHex(color), amount);
	return `#${[dark.r, dark.g, dark.b].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

function asciiAlphaMask(spriteName: SpriteName, rows: readonly string[]): SpriteAlphaMask {
	const width = rows[0]?.length || 1;
	const height = rows.length || 1;
	const alpha = new Uint8ClampedArray(width * height);
	for (let y = 0; y < height; y += 1) {
		const row = rows[y] || "";
		for (let x = 0; x < width; x += 1)
			alpha[y * width + x] = row[x] && row[x] !== "." ? 255 : 0;
	}
	return { width, height, alpha };
}

function unitOpaqueCoverage(
	unitRect: RenderedSpriteRect,
	unitMask: SpriteAlphaMask,
	unitFlipped: boolean,
	blockers: RenderedAlphaMask[],
) {
	if (!blockers.length) return 0;

	const unitScaleX = unitRect.width / unitMask.width;
	const unitScaleY = unitRect.height / unitMask.height;
	let opaque = 0;
	let covered = 0;
	for (let uy = 0; uy < unitMask.height; uy += 1) {
		const screenY = unitRect.top + (uy + 0.5) * unitScaleY;
		for (let ux = 0; ux < unitMask.width; ux += 1) {
			const maskX = unitFlipped ? unitMask.width - 1 - ux : ux;
			if (unitMask.alpha[uy * unitMask.width + maskX] === 0) continue;
			opaque += 1;
			const screenX = unitRect.left + (ux + 0.5) * unitScaleX;
			if (blockers.some((blocker) => pointInsideRect(screenX, screenY, blocker.rect) && blockerAlphaAtScreen(blocker.rect, blocker.mask, blocker.flipped, screenX, screenY) > 0))
				covered += 1;
		}
	}
	return opaque > 0 ? covered / opaque : 0;
}

function pointInsideRect(x: number, y: number, rect: RenderedSpriteRect) {
	return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function blockerAlphaAtScreen(
	rect: RenderedSpriteRect,
	mask: SpriteAlphaMask,
	flipped: boolean,
	screenX: number,
	screenY: number,
) {
	const x = Math.floor(((screenX - rect.left) / rect.width) * mask.width);
	const y = Math.floor(((screenY - rect.top) / rect.height) * mask.height);
	if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return 0;
	const maskX = flipped ? mask.width - 1 - x : x;
	return mask.alpha[y * mask.width + maskX] || 0;
}

function footprintCenter(
	x: number,
	y: number,
	width: number,
	height: number,
	camera: CameraState,
) {
	return isoToScreen(x + (width - 1) / 2, y + (height - 1) / 2, camera);
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
	const footprintBottom = centerY + (entityHeight(entity) * TILE_H * zoom) / 2;
	return footprintBottom - (bounds.maxY + 1) * scale;
}

function renderDepth(entity: RenderEntity) {
	if (entity.kind === "unit") return entity.x + entity.y + (entity.size || 0);
	return footprintRenderDepth(entity);
}

function footprintRenderDepth(entity: RenderEntity) {
	const width = entityWidth(entity);
	const height = entityHeight(entity);
	return entity.x + entity.y + (width + height - 2) / 2;
}

function renderLayerOffset(entity: RenderEntity) {
	if (entity.kind === "unit") return 2;
	if (entity.kind === "building") return 1;
	return 0;
}

function entityWidth(entity: { size?: number; width?: number }) {
	return entity.width ?? entity.size ?? 1;
}

function entityHeight(entity: { size?: number; height?: number }) {
	return entity.height ?? entity.size ?? 1;
}

function wallLineTiles(start: { x: number; y: number }, end: { x: number; y: number }) {
	const horizontal = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
	const tiles = [];
	if (horizontal) {
		const step = end.x >= start.x ? 1 : -1;
		for (let x = start.x; step > 0 ? x <= end.x : x >= end.x; x += step) tiles.push({ x, y: start.y });
	} else {
		const step = end.y >= start.y ? 1 : -1;
		for (let y = start.y; step > 0 ? y <= end.y : y >= end.y; y += step) tiles.push({ x: start.x, y });
	}
	return tiles;
}

function wallPreviewSpriteName(tiles: { x: number; y: number }[], index: number): SpriteName {
	if (tiles.length < 3 || index === 0 || index === tiles.length - 1) return "wallPillar";
	const previous = tiles[index - 1]!;
	const next = tiles[index + 1]!;
	return previous.y === next.y ? "wallNorthEast" : "wallSouthEast";
}

function canAffordLine(state: GameState, buildingType: string, tiles: { x: number; y: number }[]) {
	const player = state.snapshot?.players[state.playerId!];
	const cost = buildingCost(buildingType);
	const multiplier = tiles.filter((tile) => !ownWallAt(state, tile.x, tile.y)).length;
	return Object.entries(cost).every(([resource, amount]) => (player?.resources?.[resource as ResourceType] || 0) >= (amount as number) * multiplier);
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
