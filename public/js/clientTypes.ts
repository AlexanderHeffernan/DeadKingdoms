import type { Building, BuildingId, CommandPayload, ResourceNode, Ruin, Snapshot, Unit, UnitType } from "../../src/shared/types.js";

export type ClientSnapshot = Omit<Snapshot, "buildings"> & {
	buildings: Record<BuildingId, Building>;
};

export type Effect =
| { type: "moveCross"; x: number; y: number; createdAt: number; duration: number }
| { type: "targetFlash"; targetId: string; color?: string; createdAt: number; duration: number };

export type LastSeen = {
	buildings: Record<string, Building>;
	resources: Record<string, ResourceNode>;
	ruins: Record<string, Ruin>;
};

export type GameState = {
	playerId: string | null;
	snapshot: ClientSnapshot | null;
	selectedIds: Set<string>;
	lastSeen: LastSeen;
	effects: Effect[];
	idleWorkerCycleIndex: number;
	exploredSet: Set<number>;
	timeOffsetSeconds: number;
};

export type CameraState = { x: number; y: number; zoom?: number };

export type ViewState = {
	camera: CameraState;
	dragging: boolean;
	panning: boolean;
	dragStart: { x: number; y: number } | null;
	dragCurrent: { x: number; y: number } | null;
	panLast: { x: number; y: number } | null;
	selectedIds: Set<string>;
	buildMode: string | null;
	rallyModeBuildingId: string | null;
	noiseMode: boolean;
	instantBuildMode: boolean;
	hoverTile: { x: number; y: number } | null;
	wallDragStartTile: { x: number; y: number } | null;
	mouse: { x: number; y: number };
};

export type UIActions = {
	setBuildMode: (type: string) => void;
	train: (buildingId: string, unitType: UnitType) => void;
	blowHorn: (unitIds: string[]) => void;
	toggleAutoFarm: () => void;
	replenishFarm: (farmId: string) => void;
	deleteBuilding: (buildingId: string) => void;
	setRallyMode: (buildingId: string) => void;
	respawn: () => Promise<void>;
	disableAdminMode: () => Promise<string>;
	enableFullMapVision: () => Promise<string>;
	enableSoundDebug: () => Promise<string>;
	enableZombieDebug: () => Promise<string>;
	kickPlayer: (targetPlayerId: string) => Promise<string>;
	banPlayer: (targetPlayerId: string) => Promise<string>;
	unbanIp: (ipAddress: string) => Promise<string>;
	spawnHostileHorde: () => Promise<string>;
	grantSoldiers: () => Promise<string>;
	toggleTownCenterInvincible: () => Promise<string>;
	toggleNoiseTool: () => Promise<string>;
	toggleInstantBuild: () => Promise<string>;
	setTimeOfDay: (progress: number, label: string) => Promise<string>;
	restartServer: () => Promise<string>;
};

export type SelectionEntity = Unit | Building | ResourceNode;

export type ClientCommand = {
	[K in CommandPayload["type"]]: Omit<Extract<CommandPayload, { type: K }>, "playerId">;
}[CommandPayload["type"]];
