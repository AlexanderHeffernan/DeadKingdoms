import type { CommandPayload, CommandResult, PlayerId } from "../../src/shared/types.js";

export type ServerStatus = {
	activePlayers: number;
	maxPlayers: number;
	lastUpdate: string | null;
};

export async function getStatus(): Promise<ServerStatus> {
	const res = await fetch("/api/status");
	return res.json();
}

export async function join(name: string, color: string) {
	return post("/api/join", { name, color });
}

export async function sendCommand(payload: CommandPayload): Promise<CommandResult> {
	return post("/api/command", payload as unknown as Record<string, unknown>) as Promise<CommandResult>;
}

export async function leave(playerId: PlayerId) {
	return post("/api/leave", { playerId });
}

export async function enableAdminAccess(playerId: PlayerId, secret: string) {
	return post("/api/dev/admin-access", { playerId, secret });
}

export async function enableFullMapVision(playerId: PlayerId) {
	return post("/api/dev/full-map-vision", { playerId });
}

export async function enableSoundDebug(playerId: PlayerId, secret: string) {
	return post("/api/dev/sound-debug", { playerId, secret });
}

export async function enablePathDebug(playerId: PlayerId, secret: string) {
	return post("/api/dev/path-debug", { playerId, secret });
}

export async function spawnZombieHorde(playerId: PlayerId, count = 500) {
	return post("/api/dev/spawn-zombies", { playerId, count });
}

export async function logClientMessage(playerId: PlayerId | null, message: string) {
	return post("/api/log", { playerId, message });
}

export async function reportPing(playerId: PlayerId, pingMs: number) {
	return post("/api/ping", { playerId, pingMs });
}

export async function grantSoldiers(playerId: PlayerId, count = 100) {
	return post("/api/dev/grant-soldiers", { playerId, count });
}

async function post(url: string, payload: Record<string, unknown>) {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	return res.json();
}
