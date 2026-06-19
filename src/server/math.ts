export function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

export function moveToward(entity: { x: number; y: number }, target: { x: number; y: number }, maxStep: number): boolean {
	const dx = target.x - entity.x;
	const dy = target.y - entity.y;
	const len = Math.hypot(dx, dy);
	if (len <= maxStep || len === 0) {
		entity.x = target.x;
		entity.y = target.y;
		return true;
	}
	entity.x += (dx / len) * maxStep;
	entity.y += (dy / len) * maxStep;
	return false;
}

export type Footprint = { x: number; y: number; size?: number; width?: number; height?: number };

export function footprintWidth(entity: { size?: number; width?: number }) {
	return entity.width ?? entity.size ?? 1;
}

export function footprintHeight(entity: { size?: number; height?: number }) {
	return entity.height ?? entity.size ?? 1;
}

export function rectsOverlap(a: Footprint, b: Footprint): boolean {
	const aw = footprintWidth(a);
	const ah = footprintHeight(a);
	const bw = footprintWidth(b);
	const bh = footprintHeight(b);
	return a.x < b.x + bw && a.x + aw > b.x && a.y < b.y + bh && a.y + ah > b.y;
}
