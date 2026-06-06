import { TILE_H, TILE_W } from "./constants.js";

export function isoToScreen(x: number, y: number, camera: { x: number; y: number; zoom?: number }) {
	const zoom = camera.zoom || 1;
	return {
		x: camera.x + (x - y) * TILE_W / 2 * zoom,
		y: camera.y + (x + y) * TILE_H / 2 * zoom,
	};
}

export function screenToIso(x: number, y: number, camera: { x: number; y: number; zoom?: number }) {
	const zoom = camera.zoom || 1;
	const sx = (x - camera.x) / zoom;
	const sy = (y - camera.y) / zoom;
	return {
		x: sy / TILE_H + sx / TILE_W,
		y: sy / TILE_H - sx / TILE_W,
	};
}

export function entitySort(a: { x: number; y: number; size?: number }, b: { x: number; y: number; size?: number }) {
	const ad = (a.x + (a.size || 0)) + (a.y + (a.size || 0));
	const bd = (b.x + (b.size || 0)) + (b.y + (b.size || 0));
	return ad - bd;
}
