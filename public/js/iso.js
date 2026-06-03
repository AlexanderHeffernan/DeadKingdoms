import { TILE_H, TILE_W } from "./constants.js";

export function isoToScreen(x, y, camera) {
  const zoom = camera.zoom || 1;
  return {
    x: Math.round(camera.x + (x - y) * TILE_W / 2 * zoom),
    y: Math.round(camera.y + (x + y) * TILE_H / 2 * zoom),
  };
}

export function screenToIso(x, y, camera) {
  const zoom = camera.zoom || 1;
  const sx = (x - camera.x) / zoom;
  const sy = (y - camera.y) / zoom;
  return {
    x: sy / TILE_H + sx / TILE_W,
    y: sy / TILE_H - sx / TILE_W,
  };
}

export function entitySort(a, b) {
  const ad = (a.x + (a.size || 0)) + (a.y + (a.size || 0));
  const bd = (b.x + (b.size || 0)) + (b.y + (b.size || 0));
  return ad - bd;
}
