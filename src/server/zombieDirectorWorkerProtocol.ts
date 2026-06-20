import type { SoundFieldSource } from "../shared/soundField.js";
import type { ActionNoise, Building, Unit, Vec2, World, ZombieHorde } from "../shared/types.js";

export type ZombieDirectorWorkerSnapshot = {
	id: number;
	tick: number;
	dt: number;
	map: World["map"];
	units: Record<string, Unit>;
	buildings: Record<string, Pick<Building, "id" | "kind" | "type" | "ownerId" | "x" | "y" | "hp" | "size" | "width" | "height">>;
	actionNoises: ActionNoise[];
	occupancy: Uint8Array | undefined;
	hordes: Record<string, ZombieHorde> | undefined;
	soundSources: SoundFieldSource[];
};

export type ZombieDirectorGoal = {
	id: string;
	hordeId: string | null;
	hordeTarget: Vec2 | null;
	zombieHordeSourceTarget: Vec2 | null;
	zombieGoalKind: Exclude<Unit["zombieGoalKind"], undefined> | null;
	clearPath: boolean;
};

export type ZombieDirectorWorkerResult = {
	id: number;
	tick: number;
	durationMs: number;
	hordes: Record<string, ZombieHorde>;
	goals: ZombieDirectorGoal[];
};

export type ZombieDirectorWorkerRequest = {
	type: "step";
	snapshot: ZombieDirectorWorkerSnapshot;
};

export type ZombieDirectorWorkerResponse =
	| { type: "result"; result: ZombieDirectorWorkerResult }
	| { type: "error"; id: number; message: string };
