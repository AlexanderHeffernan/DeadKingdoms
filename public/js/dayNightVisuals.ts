import type { Building } from "../../src/shared/types.js";
import type { ClientSnapshot, ViewState } from "./clientTypes.js";
import { isoToScreen } from "./iso.js";

const LIGHT_SMOOTHING = 0.055;

type LitBuilding = {
	id: string;
	x: number;
	y: number;
	radius: number;
	alpha: number;
	scale: number;
};

export class DayNightVisuals {
	private visualNight = 0;
	private visualWarmth = 0;
	private buildings: LitBuilding[] = [];
	private tileTintCache = new Map<string, number>();
	private entityTintCache = new Map<string, number>();
	private frameKey = "";

	draw(snapshot: ClientSnapshot, view: ViewState) {
		this.visualNight = smoothToward(this.visualNight, 1 - snapshot.dayNight.light);
		this.visualWarmth = smoothToward(this.visualWarmth, phaseWarmth(snapshot.dayNight.phase));
		this.buildings = visibleLightBuildings(snapshot, view);
		this.updateFrameKey(snapshot);
	}

	hide() {
		this.buildings = [];
		this.tileTintCache.clear();
		this.entityTintCache.clear();
		this.frameKey = "";
	}

	tileTint(x: number, y: number, visible: boolean) {
		const key = `${this.frameKey}:tile:${visible ? 1 : 0}:${x}:${y}`;
		const cached = this.tileTintCache.get(key);
		if (cached !== undefined) return cached;
		const light = visible ? this.lightIntensityAt(x + 0.5, y + 0.5) : 0;
		const base = visible ? { r: 255, g: 255, b: 255 } : { r: 120, g: 138, b: 124 };
		const night = this.visualNight;
		const warm = this.visualWarmth;
		const darkened = mixRgb(base, { r: 6, g: 20, b: 39 }, night > 0.02 ? Math.min(0.76, 0.16 + night * 0.6) : 0);
		const warmed = mixRgb(darkened, { r: 232, g: 116, b: 34 }, warm * 0.28);
		const lit = mixRgb(warmed, { r: 255, g: 146, b: 54 }, light * buildingLightStrength(night));
		const tint = rgbToNumber(lit);
		this.tileTintCache.set(key, tint);
		return tint;
	}

	entityTint(entity: { kind: string; x: number; y: number; size?: number; width?: number; height?: number }) {
		const cx = entity.x + ((entity.width || entity.size || 1) - 1) / 2;
		const cy = entity.y + ((entity.height || entity.size || 1) - 1) / 2;
		const key = `${this.frameKey}:entity:${entity.kind}:${Math.round(cx * 2)}:${Math.round(cy * 2)}`;
		const cached = this.entityTintCache.get(key);
		if (cached !== undefined) return cached;
		const light = this.lightIntensityAt(cx, cy);
		const lightStrength = buildingLightStrength(this.visualNight);
		let tint: number;
		if (entity.kind === "building") {
			tint = rgbToNumber(mixRgb({ r: 255, g: 255, b: 255 }, { r: 255, g: 178, b: 86 }, Math.min(0.82, (0.48 + light * 0.5) * lightStrength)));
			this.entityTintCache.set(key, tint);
			return tint;
		}
		const night = this.visualNight;
		const dark = mixRgb({ r: 255, g: 255, b: 255 }, { r: 71, g: 91, b: 121 }, Math.min(0.52, night * 0.5));
		tint = rgbToNumber(mixRgb(dark, { r: 255, g: 176, b: 88 }, Math.min(0.82, light * 0.68 * lightStrength)));
		this.entityTintCache.set(key, tint);
		return tint;
	}

	private lightIntensityAt(x: number, y: number) {
		let max = 0;
		for (const building of this.buildings) {
			const dx = x - building.x;
			const dy = y - building.y;
			const radius = building.radius * building.scale;
			if (Math.abs(dx) > radius || Math.abs(dy) > radius) continue;
			const distance = Math.sqrt(dx * dx + dy * dy);
			const falloff = Math.max(0, 1 - distance / radius);
			if (falloff <= 0) continue;
			const coreBoost = falloff > 0.68 ? 0.32 : 0;
			const softened = Math.min(1, (Math.pow(falloff, 1.08) * 1.35 + coreBoost) * building.alpha);
			max = Math.max(max, softened);
		}
		return max;
	}

	private updateFrameKey(snapshot: ClientSnapshot) {
		const buildingKey = this.buildings.map((building) => `${building.id}:${building.alpha}:${building.scale}`).join("|");
		const key = [
			Math.round(this.visualNight * 100),
			Math.round(this.visualWarmth * 100),
			buildingKey,
		].join(":");
		if (key === this.frameKey) return;
		this.frameKey = key;
		this.tileTintCache.clear();
		this.entityTintCache.clear();
	}
}

function visibleLightBuildings(snapshot: ClientSnapshot, view: ViewState): LitBuilding[] {
	return Object.values(snapshot.buildings)
		.filter((building) => isBuildingNearViewport(building, view))
		.map((building) => {
			const width = building.width || building.size || 1;
			const height = building.height || building.size || 1;
			const flicker = flickerFor(building.id, performance.now());
			return {
				id: building.id,
				x: building.x + (width - 1) / 2,
				y: building.y + (height - 1) / 2,
				radius: 8.5 + Math.max(width, height) * 2.1,
				alpha: Math.round(flicker.alpha * 100) / 100,
				scale: Math.round(flicker.scale * 100) / 100,
			};
		});
}

function smoothToward(current: number, target: number) {
	return current + (target - current) * LIGHT_SMOOTHING;
}

function buildingLightStrength(night: number) {
	return Math.max(0, Math.min(1, (night - 0.12) / 0.58));
}

function flickerFor(id: string, now: number) {
	const seed = hash(id);
	const t = now / 1000;
	const a = Math.sin(t * (2.1 + (seed % 17) * 0.013) + seed * 0.017);
	const b = Math.sin(t * (4.6 + (seed % 23) * 0.011) + seed * 0.031);
	const amount = (a * 0.65 + b * 0.35) * 0.5 + 0.5;
	return {
		alpha: 0.94 + amount * 0.1,
		scale: 0.985 + amount * 0.03,
	};
}

function hash(value: string) {
	let out = 2166136261;
	for (let i = 0; i < value.length; i += 1) {
		out ^= value.charCodeAt(i);
		out = Math.imul(out, 16777619);
	}
	return out >>> 0;
}

function phaseWarmth(phase: ClientSnapshot["dayNight"]["phase"]) {
	if (phase === "dawn") return 0.65;
	if (phase === "dusk") return 1;
	return 0;
}

function mixRgb(from: Rgb, to: Rgb, amount: number) {
	const t = Math.max(0, Math.min(1, amount));
	return {
		r: Math.round(from.r + (to.r - from.r) * t),
		g: Math.round(from.g + (to.g - from.g) * t),
		b: Math.round(from.b + (to.b - from.b) * t),
	};
}

type Rgb = { r: number; g: number; b: number };

function rgbToNumber(color: Rgb) {
	return (color.r << 16) | (color.g << 8) | color.b;
}

function isBuildingNearViewport(building: Building, view: ViewState) {
	const center = isoToScreen(
		building.x + ((building.width || building.size || 1) - 1) / 2,
		building.y + ((building.height || building.size || 1) - 1) / 2,
		view.camera,
	);
	return (
		center.x > -360 &&
		center.x < window.innerWidth + 360 &&
		center.y > -260 &&
		center.y < window.innerHeight + 260
	);
}
