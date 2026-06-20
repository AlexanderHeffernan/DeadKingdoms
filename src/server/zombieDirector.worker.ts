import { parentPort } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import type { World } from "../shared/types.js";
import { stepZombieDirector } from "./zombieDirector.js";
import { ZOMBIE_OWNER_ID } from "./zombieSpawning.js";
import type {
	ZombieDirectorGoal,
	ZombieDirectorWorkerRequest,
	ZombieDirectorWorkerResponse,
	ZombieDirectorWorkerSnapshot,
} from "./zombieDirectorWorkerProtocol.js";

if (!parentPort) throw new Error("Zombie director worker requires a parent port.");

parentPort.on("message", (message: ZombieDirectorWorkerRequest) => {
	if (message.type !== "step") return;
	const { snapshot } = message;
	try {
		const startedAt = performance.now();
		const world = worldFromSnapshot(snapshot);
		stepZombieDirector(world, snapshot.dt, { soundSources: snapshot.soundSources });
		const result = {
			id: snapshot.id,
			tick: snapshot.tick,
			durationMs: performance.now() - startedAt,
			hordes: world._zombieHordes || {},
			goals: zombieGoals(world),
		};
		parentPort!.postMessage({ type: "result", result } satisfies ZombieDirectorWorkerResponse);
	} catch (error) {
		parentPort!.postMessage({
			type: "error",
			id: snapshot.id,
			message: error instanceof Error ? error.message : String(error),
		} satisfies ZombieDirectorWorkerResponse);
	}
});

function worldFromSnapshot(snapshot: ZombieDirectorWorkerSnapshot): World {
	const world: World = {
		map: snapshot.map,
		players: {},
		units: snapshot.units,
		buildings: snapshot.buildings as World["buildings"],
		resources: {},
		ruins: {},
		corpses: {},
		notices: [],
		adminLogs: [],
		actionNoises: snapshot.actionNoises,
		leaderboard: [],
		tick: snapshot.tick,
		spawnTimers: {},
		serverPerf: { tps: 0, tickMs: 0, samples: [] },
	};
	if (snapshot.occupancy) world._occupancy = snapshot.occupancy;
	if (snapshot.hordes) world._zombieHordes = snapshot.hordes;
	return world;
}

function zombieGoals(world: World): ZombieDirectorGoal[] {
	const goals: ZombieDirectorGoal[] = [];
	for (const unit of Object.values(world.units)) {
		if (unit.ownerId !== ZOMBIE_OWNER_ID) continue;
		goals.push({
			id: unit.id,
			hordeId: unit.hordeId ?? null,
			hordeTarget: unit.hordeTarget ?? null,
			zombieHordeSourceTarget: unit.zombieHordeSourceTarget ?? null,
			zombieGoalKind: unit.zombieGoalKind ?? null,
			clearPath: !!unit.zombiePathTarget && !!unit.zombieHordeSourceTarget,
		});
	}
	return goals;
}
