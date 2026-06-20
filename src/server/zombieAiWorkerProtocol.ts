import type { Building, Corpse, PathNode, Unit, UnitId, Vec2, World } from "../shared/types.js";

export type ZombieAiWorkerSnapshot = {
	id: number;
	tick: number;
	dt: number;
	map: World["map"];
	units: Record<string, Unit>;
	buildings: Record<string, ZombieAiWorkerBuilding>;
	corpses: Record<string, Corpse>;
	occupancy: Uint8Array | undefined;
	zombies: ZombieAiStep[];
};

export type ZombieAiStep = {
	id: UnitId;
	dt: number;
	cadence: number;
};

export type ZombieAiWorkerBuilding = Pick<
Building,
"id" | "kind" | "type" | "ownerId" | "x" | "y" | "hp" | "maxHp" | "size" | "width" | "height" | "walkBlocking" | "invincible"
>;

export type ZombieAiUnitState = Pick<
Unit,
"id" | "x" | "y" | "cooldown" | "attackFlash" | "workFlash" | "facing"
> & {
	command: Unit["command"];
	vision: number | null;
	hordeTarget: Vec2 | null;
	zombieGoalKind: "sound" | "target" | "drift" | "wander" | null;
	zombiePath: PathNode[] | null;
	zombiePathTarget: Vec2 | null;
	zombieStuckTicks: number;
	retargetIn: number;
	hordeId: string | null;
	zombieDriftDirection: Vec2 | null;
	zombieHordeSourceTarget: Vec2 | null;
};

export type ZombieAiAttackIntent = {
	attackerId: UnitId;
	targetId: string;
	amount: number;
	attackerOwnerId: Unit["ownerId"];
	cooldown: number;
	attackFlash: number;
};

export type ZombieAiWorkerResult = {
	id: number;
	tick: number;
	durationMs: number;
	units: ZombieAiUnitState[];
	attacks: ZombieAiAttackIntent[];
	detail: ZombieAiWorkerDetail[];
};

export type ZombieAiWorkerDetail = {
	name: string;
	label: string;
	count: number;
	ms: number;
	averageMs: number;
};

export type ZombieAiWorkerRequest = {
	type: "step";
	snapshot: ZombieAiWorkerSnapshot;
};

export type ZombieAiWorkerResponse =
	| { type: "result"; result: ZombieAiWorkerResult }
	| { type: "error"; id: number; message: string };

export type ZombieAiAttackRecorder = {
	attacks: ZombieAiAttackIntent[];
	damage(target: Unit | Building | Corpse, amount: number, attackerId: Unit["ownerId"], attacker: Unit): void;
	attackBlockingBuilding(attacker: Unit, targetPoint: Vec2): void;
};
