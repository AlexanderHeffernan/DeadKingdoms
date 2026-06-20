import { Worker } from "node:worker_threads";
import type { ServerPerfWorkerStats, Unit, World } from "../shared/types.js";
import type {
	ZombieAiAttackIntent,
	ZombieAiStep,
	ZombieAiUnitState,
	ZombieAiWorkerRequest,
	ZombieAiWorkerResponse,
	ZombieAiWorkerResult,
	ZombieAiWorkerSnapshot,
} from "./zombieAiWorkerProtocol.js";

const WORKER_DISABLED = process.env.ZOMBIE_AI_WORKER === "0";

export type ZombieAiWorkerStepProfiler = {
	measure<T>(name: string, label: string, count: number, work: () => T): T;
};

export class ZombieAiWorkerClient {
	private worker: Worker | null = null;
	private nextId = 1;
	private pending = false;
	private latestResult: ZombieAiWorkerResult | null = null;
	private lastAppliedTick: number | null = null;
	private lastCompletedTick: number | null = null;
	private lastDurationMs = 0;
	private failures = 0;
	private lastError: string | null = null;
	private fallback = WORKER_DISABLED;

	step(
		world: World,
		dt: number,
		zombies: ZombieAiStep[],
		applyAttack: (attack: ZombieAiAttackIntent) => void,
		profiler: ZombieAiWorkerStepProfiler | null = null,
	): boolean {
		if (this.fallback || zombies.length === 0) {
			measureWorkerStep(profiler, "zombieAiWorkerStatus", "Zombie AI worker status", 1, () => this.writePerf(world, "fallback"));
			return false;
		}
		measureWorkerStep(profiler, "zombieAiWorkerEnsure", "Zombie AI worker ensure", 1, () => this.ensureWorker(world));
		if (!this.worker) {
			measureWorkerStep(profiler, "zombieAiWorkerStatus", "Zombie AI worker status", 1, () => this.writePerf(world, "fallback"));
			return false;
		}
		measureWorkerStep(profiler, "zombieAiWorkerApply", "Zombie AI worker apply", this.latestResult?.units.length ?? 0, () => this.applyLatestResult(world, applyAttack));
		this.startNext(world, dt, zombies, profiler);
		measureWorkerStep(profiler, "zombieAiWorkerStatus", "Zombie AI worker status", 1, () => this.writePerf(world, "worker"));
		return true;
	}

	dispose() {
		void this.worker?.terminate();
		this.worker = null;
		this.pending = false;
	}

	private ensureWorker(world: World) {
		if (this.worker) return;
		try {
			this.worker = new Worker(new URL("./zombieAi.worker.js", import.meta.url));
			this.worker.on("message", (message: ZombieAiWorkerResponse) => this.handleMessage(message));
			this.worker.on("error", (error) => this.fail(world, error.message));
			this.worker.on("exit", (code) => {
				this.worker = null;
				this.pending = false;
				if (code !== 0) this.fail(world, `Worker exited with code ${code}.`);
			});
		} catch {
			this.fail(world, "Could not start zombie AI worker.");
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

	private handleMessage(message: ZombieAiWorkerResponse) {
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

	private applyLatestResult(world: World, applyAttack: (attack: ZombieAiAttackIntent) => void) {
		const result = this.latestResult;
		if (!result) return;
		this.latestResult = null;
		for (const attack of result.attacks) applyAttack(attack);
		for (const state of result.units) this.applyUnitState(world, state);
		this.lastAppliedTick = result.tick;
	}

	private applyUnitState(world: World, state: ZombieAiUnitState) {
		const unit = world.units[state.id];
		if (!unit || unit.type !== "zombie" || unit.hp <= 0) return;
		unit.x = state.x;
		unit.y = state.y;
		unit.command = state.command;
		unit.cooldown = state.cooldown;
		unit.attackFlash = state.attackFlash;
		unit.workFlash = state.workFlash;
		unit.facing = state.facing;
		if (state.vision === null) delete unit.vision;
			else unit.vision = state.vision;
		unit.hordeTarget = state.hordeTarget;
		unit.zombieGoalKind = state.zombieGoalKind;
		unit.zombiePath = state.zombiePath;
		unit.zombiePathTarget = state.zombiePathTarget;
		unit.zombieStuckTicks = state.zombieStuckTicks;
		unit.retargetIn = state.retargetIn;
		unit.hordeId = state.hordeId;
		unit.zombieDriftDirection = state.zombieDriftDirection;
		unit.zombieHordeSourceTarget = state.zombieHordeSourceTarget;
	}

	private startNext(world: World, dt: number, zombies: ZombieAiStep[], profiler: ZombieAiWorkerStepProfiler | null) {
		if (!this.worker || this.pending) return;
		const snapshot = measureWorkerStep(profiler, "zombieAiWorkerSnapshot", "Zombie AI worker snapshot", zombies.length, () => this.snapshot(world, dt, zombies));
		const request: ZombieAiWorkerRequest = { type: "step", snapshot };
		this.pending = true;
		measureWorkerStep(profiler, "zombieAiWorkerPost", "Zombie AI worker postMessage", zombies.length, () => this.worker!.postMessage(request));
	}

	private snapshot(world: World, dt: number, zombies: ZombieAiStep[]): ZombieAiWorkerSnapshot {
		return {
			id: this.nextId++,
			tick: world.tick,
			dt,
			map: world.map,
			units: snapshotUnits(world),
			buildings: snapshotBuildings(world),
			corpses: snapshotCorpses(world),
			occupancy: world._occupancy ? new Uint8Array(world._occupancy) : undefined,
			zombies,
		};
	}

	private writePerf(world: World, mode: ServerPerfWorkerStats["mode"]) {
		world._zombieAiWorkerPerf = {
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

function measureWorkerStep<T>(profiler: ZombieAiWorkerStepProfiler | null, name: string, label: string, count: number, work: () => T): T {
	if (!profiler) return work();
	return profiler.measure(name, label, count, work);
}

function snapshotUnits(world: World) {
	const units: Record<string, Unit> = {};
	for (const unit of Object.values(world.units)) {
		if (unit.hp <= 0) continue;
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
		maxHp: building.maxHp,
		size: building.size,
		width: building.width,
		height: building.height,
		walkBlocking: building.walkBlocking,
		invincible: building.invincible ?? false,
	}]));
}

function snapshotCorpses(world: World) {
	return Object.fromEntries(Object.values(world.corpses).map((corpse) => [corpse.id, { ...corpse }]));
}
