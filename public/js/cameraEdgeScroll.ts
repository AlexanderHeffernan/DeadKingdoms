import type { CameraState } from "./clientTypes.js";

type Vec2 = {
	x: number;
	y: number;
};

export const DEFAULT_EDGE_SCROLL_SPEED = 10;
export const MIN_EDGE_SCROLL_SPEED = 4;
export const MAX_EDGE_SCROLL_SPEED = 20;
export const EDGE_SCROLL_MARGIN = 14;

export class CameraEdgeScroll {
	private enabled = true;
	private speed = DEFAULT_EDGE_SCROLL_SPEED;

	setEnabled(enabled: boolean) {
		this.enabled = enabled;
	}

	setSpeed(speed: number) {
		this.speed = clampEdgeScrollSpeed(speed);
	}

	step(camera: CameraState, mouse: Vec2, viewport: Vec2) {
		if (!this.enabled) return false;
		let moved = false;
		if (mouse.x <= EDGE_SCROLL_MARGIN) {
			camera.x += this.speed;
			moved = true;
		}
		if (mouse.x >= viewport.x - EDGE_SCROLL_MARGIN) {
			camera.x -= this.speed;
			moved = true;
		}
		if (mouse.y <= EDGE_SCROLL_MARGIN) {
			camera.y += this.speed;
			moved = true;
		}
		if (mouse.y >= viewport.y - EDGE_SCROLL_MARGIN) {
			camera.y -= this.speed;
			moved = true;
		}
		return moved;
	}
}

export function clampEdgeScrollSpeed(value: number) {
	if (!Number.isFinite(value)) return DEFAULT_EDGE_SCROLL_SPEED;
	return Math.min(MAX_EDGE_SCROLL_SPEED, Math.max(MIN_EDGE_SCROLL_SPEED, Math.round(value)));
}
