import { sprites } from "../sprites/index.js";
import { palette } from "../sprites/palette.js";
import { pngSprites } from "../sprites/pngSprites.js";
import type { SpriteName } from "../../../src/shared/types.js";

export type HudIconOffset = {
	x: number;
	y: number;
};

export const DEFAULT_HUD_ICON_OFFSET: HudIconOffset = { x: 0, y: 0 };
export const DEFAULT_HUD_ICON_MAX_SIZE = 28;

export function icon(
	spriteName: string,
	offset: HudIconOffset = DEFAULT_HUD_ICON_OFFSET,
	maxSize = DEFAULT_HUD_ICON_MAX_SIZE,
) {
	const png = pngSprites[spriteName as SpriteName];
	if (png) return pngIcon(png, offset, maxSize);
	const canvas = document.createElement("canvas");
	canvas.className = "action-icon";
	canvas.width = 56;
	canvas.height = 56;
	const ctx = canvas.getContext("2d")!;
	ctx.imageSmoothingEnabled = false;
	const rows = sprites[spriteName as SpriteName] || sprites.house!;
	const scale = Math.max(1, Math.floor(52 / Math.max(rows.length, rows[0]!.length)));
	const ox = Math.floor((56 - rows[0]!.length * scale) / 2);
	const oy = Math.floor((56 - rows.length * scale) / 2);
	for (let y = 0; y < rows.length; y += 1) {
		for (let x = 0; x < rows[y]!.length; x += 1) {
			const key = rows[y]![x];
			const color = key === "p" ? "#4f8fd8" : key === "P" ? "#7eb2ee" : palette[key as keyof typeof palette];
			if (!color) continue;
			ctx.fillStyle = color;
			ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale);
		}
	}
	return canvas;
}

function pngIcon(png: NonNullable<(typeof pngSprites)[SpriteName]>, offset: HudIconOffset, maxSize: number) {
	const wrapper = document.createElement("span");
	const scale = Math.min(2, maxSize / png.width, maxSize / png.height);
	wrapper.className = "action-icon action-icon-png";
	wrapper.style.setProperty("--icon-width", `${png.width * scale}px`);
	wrapper.style.setProperty("--icon-height", `${png.height * scale}px`);
	wrapper.style.setProperty("--icon-offset-x", `${offset.x}px`);
	wrapper.style.setProperty("--icon-offset-y", `${offset.y}px`);
	if (png.flag && png.flagLayer !== "over") wrapper.append(pngFlagLayer(png.flag));
	const base = document.createElement("img");
	base.src = png.base;
	base.alt = "";
	base.draggable = false;
	base.className = "action-icon-png-layer";
	wrapper.append(base);
	if (png.flag && png.flagLayer === "over") wrapper.append(pngFlagLayer(png.flag));
	return wrapper;
}

function pngFlagLayer(flagUrl: string) {
	const flag = document.createElement("span");
	flag.className = "action-icon-png-layer action-icon-png-flag";
	flag.style.setProperty("--flag-url", `url("${flagUrl}")`);
	return flag;
}
