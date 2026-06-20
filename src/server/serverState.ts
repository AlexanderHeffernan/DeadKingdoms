import { Logs } from "../shared/logs.js";
import { addAdminLog, createWorld } from "./world.js";
import type { World } from "../shared/types.js";

const IDLE_RESET_MS = 59 * 1000;

export type ResetStatus =
	| { state: "active"; idleResetMs: number; resetAt: null }
	| { state: "countdown"; idleResetMs: number; resetAt: number }
	| { state: "cold"; idleResetMs: number; resetAt: null };

export class ServerState {
	private world: World | null = null;
	private emptySince: number | null = null;

	currentWorld() {
		return this.world;
	}

	ensureWorld() {
		if (!this.world) {
			this.world = createWorld();
			this.emptySince = null;
			Logs.log("Generated a new world.");
		}
		return this.world;
	}

	recordLog(source: string, message: string, at = Date.now()) {
		const world = this.currentWorld();
		if (world) addAdminLog(world, source, message, at);
	}

	restartNow(source: string) {
		this.world = null;
		this.emptySince = null;
		Logs.log(`${source} restarted the server world.`);
	}

	resetStatus(hasPlayers: boolean, now = Date.now()): ResetStatus {
		if (!this.world) return { state: "cold", idleResetMs: IDLE_RESET_MS, resetAt: null };
		if (hasPlayers) return { state: "active", idleResetMs: IDLE_RESET_MS, resetAt: null };
		return { state: "countdown", idleResetMs: IDLE_RESET_MS, resetAt: (this.emptySince ?? now) + IDLE_RESET_MS };
	}

	stepIdleReset(hasPlayers: boolean, now = Date.now()) {
		if (!this.world) return;
		if (hasPlayers) {
			this.emptySince = null;
			return;
		}
		this.emptySince ??= now;
		if (now - this.emptySince < IDLE_RESET_MS) return;
		this.world = null;
		this.emptySince = null;
		Logs.log("Cleared idle world after 59 seconds with no players.");
	}
}
