type PanPoint = {
	x: number;
	y: number;
	at: number;
};

type PanDelta = {
	x: number;
	y: number;
};

export class CameraPanThrow {

	private static MIN_THROW_SPEED = 0.45;
	private static MAX_THROW_SPEED = 3;
	private static THROW_DECAY_MS = 360;
	private static STOP_THROW_SPEED = 0.035;
	private static VELOCITY_SMOOTHING = 0.35;
	private static MIN_SAMPLE_MS = 8;
	private static MAX_SAMPLE_MS = 80;

	private enabled = false;
	private lastPoint: PanPoint | null = null;
	private velocity: PanDelta = { x: 0, y: 0 };
	private throwing = false;
	private lastThrowAt = 0;

	setEnabled(enabled: boolean) {
		this.enabled = enabled;
		if (!enabled) this.stop();
	}

	begin(x: number, y: number, at = performance.now()) {
		this.stop();
		this.lastPoint = { x, y, at };
	}

	move(x: number, y: number, at = performance.now()): PanDelta {
		if (!this.lastPoint) {
			this.begin(x, y, at);
			return { x: 0, y: 0 };
		}
		const dx = x - this.lastPoint.x;
		const dy = y - this.lastPoint.y;
		this.recordVelocity(dx, dy, at - this.lastPoint.at);
		this.lastPoint = { x, y, at };
		return { x: dx, y: dy };
	}

	recordDelta(delta: PanDelta, at = performance.now()) {
		if (!this.lastPoint) {
			this.lastPoint = { x: 0, y: 0, at };
			return;
		}
		this.recordVelocity(delta.x, delta.y, at - this.lastPoint.at);
		this.lastPoint = { x: 0, y: 0, at };
	}

	release(at = performance.now()) {
		this.lastPoint = null;
		if (!this.enabled || this.speed() < CameraPanThrow.MIN_THROW_SPEED) {
			this.stop();
			return;
		}
		this.capVelocity();
		this.throwing = true;
		this.lastThrowAt = at;
	}

	step(at = performance.now()): PanDelta {
		if (!this.throwing) return { x: 0, y: 0 };
		const dt = Math.min(CameraPanThrow.MAX_SAMPLE_MS, Math.max(0, at - this.lastThrowAt));
		this.lastThrowAt = at;
		const delta = { x: this.velocity.x * dt, y: this.velocity.y * dt };
		this.decayVelocity(dt);
		if (this.speed() < CameraPanThrow.STOP_THROW_SPEED) this.stop();
		return delta;
	}

	stop() {
		this.lastPoint = null;
		this.throwing = false;
		this.velocity = { x: 0, y: 0 };
	}

	private recordVelocity(dx: number, dy: number, elapsedMs: number) {
		if (!this.enabled) return;
		const dt = Math.min(CameraPanThrow.MAX_SAMPLE_MS, Math.max(CameraPanThrow.MIN_SAMPLE_MS, elapsedMs));
		const next = { x: dx / dt, y: dy / dt };
		this.velocity = {
			x: this.velocity.x * (1 - CameraPanThrow.VELOCITY_SMOOTHING) + next.x * CameraPanThrow.VELOCITY_SMOOTHING,
			y: this.velocity.y * (1 - CameraPanThrow.VELOCITY_SMOOTHING) + next.y * CameraPanThrow.VELOCITY_SMOOTHING,
		};
		this.capVelocity();
	}

	private decayVelocity(dt: number) {
		const decay = Math.exp(-dt / CameraPanThrow.THROW_DECAY_MS);
		this.velocity = {
			x: this.velocity.x * decay,
			y: this.velocity.y * decay,
		};
	}

	private capVelocity() {
		const speed = this.speed();
		if (speed <= CameraPanThrow.MAX_THROW_SPEED) return;
		const scale = CameraPanThrow.MAX_THROW_SPEED / speed;
		this.velocity = {
			x: this.velocity.x * scale,
			y: this.velocity.y * scale,
		};
	}

	private speed() {
		return Math.hypot(this.velocity.x, this.velocity.y);
	}
}
