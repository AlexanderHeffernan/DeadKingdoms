import { Worker } from "node:worker_threads";
import { collectWorldSoundSources } from "../shared/soundField.js";
import type { ServerPerfZombieWorkerStats, Unit, World, ZombieHorde } from "../shared/types.js";
import { stepZombieDirector } from "./zombieDirector.js";
import type {
	ZombieDirectorGoal,
	ZombieDirectorWorkerRequest,
	ZombieDirectorWorkerResponse,
	ZombieDirectorWorkerResult,
	ZombieDirectorWorkerSnapshot,
} from "./zombieDirectorWorkerProtocol.js";
import { ZOMBIE_OWNER_ID } from "./zombieSpawning.js";

const WORKER_DISABLED = process.env.ZOMBIE_DIRECTOR_WORKER === "0";
const MAX_ZOMBIE_DIRECTOR_CATCH_UP_SECONDS = 0.5;

export class ZombieDirectorWorkerClient {
	private worker: Worker | null = null;
	private nextId = 1;
	private pending = false;
	private latestResult: ZombieDirectorWorkerResult | null = null;
	private lastAppliedTick: number | null = null;
	private lastCompletedTick: number | null = null;
	private lastDurationMs = 0;
	private failures = 0;
	private lastError: string | null = null;
	private fallback = WORKER_DISABLED;
	private queuedDt = 0;

	step(world: World, dt: number) {
		if (this.fallback || !world._zombieHordes) {
			stepZombieDirector(world, dt);
			if (!this.fallback) this.startNext(world, dt);
			this.writePerf(world, "fallback");
			return;
		}
		this.ensureWorker(world);
		this.applyLatestResult(world);
		this.startNext(world, dt);
		this.writePerf(world, "worker");
	}

	dispose() {
		void this.worker?.terminate();
		this.worker = null;
		this.pending = false;
		this.queuedDt = 0;
	}

	private ensureWorker(world: World) {
		if (this.worker) return;
		try {
			this.worker = new Worker(new URL("./zombieDirector.worker.js", import.meta.url));
			this.worker.on("message", (message: ZombieDirectorWorkerResponse) => this.handleMessage(message));
			this.worker.on("error", (error) => this.fail(world, error.message));
			this.worker.on("exit", (code) => {
				this.worker = null;
				this.pending = false;
				if (code !== 0) this.fail(world, `Worker exited with code ${code}.`);
			});
		} catch {
			this.fail(world, "Could not start zombie director worker.");
		}
	}

	private fail(world: World, message: string) {
		this.failures += 1;
		this.lastError = message;
		this.fallback = true;
		this.pending = false;
		this.dispose();
		this.writePerf(world, "fallback");
	}

	private handleMessage(message: ZombieDirectorWorkerResponse) {
		this.pending = false;
		if (message.type === "error") {
			this.failures += 1;
			this.lastError = message.message;
			return;
		}
		this.latestResult = message.result;
		this.lastCompletedTick = message.result.tick;
		this.lastDurationMs = message.result.durationMs;
	}

	private applyLatestResult(world: World) {
		const result = this.latestResult;
		if (!result) return;
		this.latestResult = null;
		world._zombieHordes = result.hordes;
		for (const goal of result.goals) this.applyGoal(world, goal);
		this.lastAppliedTick = result.tick;
	}

	private applyGoal(world: World, goal: ZombieDirectorGoal) {
		const zombie = world.units[goal.id];
		if (!zombie || zombie.ownerId !== ZOMBIE_OWNER_ID || zombie.hp <= 0) return;
		const previousSource = zombie.zombieHordeSourceTarget ?? null;
		zombie.hordeId = goal.hordeId;
		zombie.hordeTarget = goal.hordeTarget;
		zombie.zombieHordeSourceTarget = goal.zombieHordeSourceTarget;
		zombie.zombieGoalKind = goal.zombieGoalKind ?? null;
		if (!samePoint(previousSource, goal.zombieHordeSourceTarget)) {
			zombie.zombiePath = null;
			zombie.zombiePathTarget = null;
			zombie.zombieStuckTicks = 0;
		}
	}

	private startNext(world: World, dt: number) {
		if (!this.worker) return;
		if (this.pending) {
			this.queuedDt = Math.min(MAX_ZOMBIE_DIRECTOR_CATCH_UP_SECONDS, this.queuedDt + dt);
			return;
		}
		const stepDt = Math.min(MAX_ZOMBIE_DIRECTOR_CATCH_UP_SECONDS, dt + this.queuedDt);
		this.queuedDt = 0;
		const snapshot = this.snapshot(world, stepDt);
		const request: ZombieDirectorWorkerRequest = { type: "step", snapshot };
		this.pending = true;
		this.worker.postMessage(request);
	}

	private snapshot(world: World, dt: number): ZombieDirectorWorkerSnapshot {
		return {
			id: this.nextId++,
			tick: world.tick,
			dt,
			map: world.map,
			units: snapshotUnits(world),
			buildings: snapshotBuildings(world),
			actionNoises: world.actionNoises.map((noise) => ({ ...noise })),
			occupancy: world._occupancy ? new Uint8Array(world._occupancy) : undefined,
			hordes: snapshotHordes(world._zombieHordes),
			soundSources: collectWorldSoundSources(world, ZOMBIE_OWNER_ID),
		};
	}

	private writePerf(world: World, mode: ServerPerfZombieWorkerStats["mode"]) {
		world._zombieWorkerPerf = {
			enabled: !WORKER_DISABLED,
			pending: this.pending,
			lastDurationMs: this.lastDurationMs,
			lastCompletedTick: this.lastCompletedTick,
			lastAppliedTick: this.lastAppliedTick,
			failures: this.failures,
			mode,
			...(this.lastError ? { lastError: this.lastError } : {}),
		};
	}
}

function snapshotUnits(world: World) {
	const units: Record<string, Unit> = {};
	for (const unit of Object.values(world.units)) {
		if (unit.ownerId !== ZOMBIE_OWNER_ID && unit.hp <= 0) continue;
		units[unit.id] = {
			...unit,
			command: { ...unit.command },
			carried: unit.carried ? { ...unit.carried } : null,
			hordeTarget: unit.hordeTarget ? { ...unit.hordeTarget } : null,
			zombiePath: unit.zombiePath ? unit.zombiePath.map((node) => ({ x: node.x, y: node.y })) : null,
			zombiePathTarget: unit.zombiePathTarget ? { ...unit.zombiePathTarget } : null,
			zombieDriftDirection: unit.zombieDriftDirection ? { ...unit.zombieDriftDirection } : null,
			zombieHordeSourceTarget: unit.zombieHordeSourceTarget ? { ...unit.zombieHordeSourceTarget } : null,
		};
	}
	return units;
}

function snapshotBuildings(world: World) {
	return Object.fromEntries(Object.values(world.buildings).map((building) => [building.id, {
		id: building.id,
		kind: building.kind,
		type: building.type,
		ownerId: building.ownerId,
		x: building.x,
		y: building.y,
		hp: building.hp,
		size: building.size,
		width: building.width,
		height: building.height,
	}]));
}

function snapshotHordes(hordes: Record<string, ZombieHorde> | undefined) {
	if (!hordes) return undefined;
	return Object.fromEntries(Object.entries(hordes).map(([id, horde]) => [id, {
		...horde,
		memberIds: [...horde.memberIds],
		center: { ...horde.center },
		target: horde.target ? { ...horde.target } : null,
		wanderTarget: horde.wanderTarget ? { ...horde.wanderTarget } : null,
		driftDirection: horde.driftDirection ? { ...horde.driftDirection } : null,
		soundMemory: horde.soundMemory ? {
			...horde.soundMemory,
			direction: { ...horde.soundMemory.direction },
			target: { ...horde.soundMemory.target },
		} : null,
	}]));
}

function samePoint(a: { x: number; y: number } | null, b: { x: number; y: number } | null) {
	if (!a || !b) return a === b;
	return Math.hypot(a.x - b.x, a.y - b.y) <= 0.2;
}
