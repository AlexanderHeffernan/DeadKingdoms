type PanPoint = {
	x: number;
	y: number;
};

type PanDelta = {
	x: number;
	y: number;
};

export const DEFAULT_DRAG_PAN_SENSITIVITY = 1;
export const MIN_DRAG_PAN_SENSITIVITY = 0.5;
export const MAX_DRAG_PAN_SENSITIVITY = 3;

export class CameraDragPan {
	private sensitivity = DEFAULT_DRAG_PAN_SENSITIVITY;
	private pointerLockEnabled = true;
	private lastPoint: PanPoint | null = null;
	private pointerLockElement: HTMLElement | null = null;

	setSensitivity(sensitivity: number) {
		this.sensitivity = clampDragPanSensitivity(sensitivity);
	}

	setPointerLockEnabled(enabled: boolean) {
		this.pointerLockEnabled = enabled;
		if (!enabled && this.isPointerLocked()) document.exitPointerLock();
	}

	begin(target: HTMLElement, x: number, y: number) {
		this.lastPoint = { x, y };
		if (this.pointerLockEnabled) {
			this.pointerLockElement = target;
			try {
				target.requestPointerLock();
			} catch {
				this.pointerLockElement = null;
			}
		}
	}

	move(event: MouseEvent): PanDelta {
		const locked = this.isPointerLocked();
		const delta = locked ? { x: event.movementX, y: event.movementY } : this.unlockedDelta(event.clientX, event.clientY);
		const sensitivity = locked ? this.sensitivity : 1;
		return {
			x: delta.x * sensitivity,
			y: delta.y * sensitivity,
		};
	}

	end() {
		this.lastPoint = null;
		if (this.isPointerLocked()) document.exitPointerLock();
		this.pointerLockElement = null;
	}

	cancelPointerLockExit() {
		if (!this.isPointerLocked()) {
			this.pointerLockElement = null;
			this.lastPoint = null;
		}
	}

	private unlockedDelta(x: number, y: number): PanDelta {
		if (!this.lastPoint) {
			this.lastPoint = { x, y };
			return { x: 0, y: 0 };
		}
		const delta = {
			x: x - this.lastPoint.x,
			y: y - this.lastPoint.y,
		};
		this.lastPoint = { x, y };
		return delta;
	}

	private isPointerLocked() {
		return this.pointerLockElement !== null && document.pointerLockElement === this.pointerLockElement;
	}
}

export function clampDragPanSensitivity(value: number) {
	if (!Number.isFinite(value)) return DEFAULT_DRAG_PAN_SENSITIVITY;
	return Math.min(MAX_DRAG_PAN_SENSITIVITY, Math.max(MIN_DRAG_PAN_SENSITIVITY, value));
}
