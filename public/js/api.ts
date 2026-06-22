import type { CommandPayload, CommandResult, GlobalLeaderboardEntry, LeaderboardPreviewSnapshot, PlayerId } from "../../src/shared/types.js";

export type ServerStatus = {
	activePlayers: number;
	maxPlayers: number;
	deadKingdoms: number;
	lastUpdate: string | null;
	reset: {
		state: "active" | "countdown" | "cold";
		idleResetMs: number;
		resetAt: number | null;
	};
};

export type ChangelogEntry = {
	sha: string;
	message: string;
	url: string;
	date: string | null;
};

export type Changelog = {
	generatedAt: string | null;
	repository: string;
	entries: ChangelogEntry[];
};

export async function getStatus(): Promise<ServerStatus> {
	const res = await fetch("/api/status");
	return res.json();
}

export async function getGlobalLeaderboard(): Promise<{ entries: GlobalLeaderboardEntry[] }> {
	const res = await fetch("/api/global-leaderboard");
	return res.json();
}

export async function getGlobalLeaderboardSnapshot(snapshotId: string, playerId?: PlayerId): Promise<{ ok: boolean; snapshot?: LeaderboardPreviewSnapshot; error?: string }> {
	const params = playerId ? `?playerId=${encodeURIComponent(playerId)}` : "";
	const res = await fetch(`/api/global-leaderboard/${encodeURIComponent(snapshotId)}${params}`);
	return res.json();
}

export async function getChangelog(): Promise<Changelog> {
	const res = await fetch("/api/changelog");
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

export async function disableAdminMode(playerId: PlayerId) {
	return post("/api/dev/disable-admin", { playerId });
}

export async function enableFullMapVision(playerId: PlayerId) {
	return post("/api/dev/full-map-vision", { playerId });
}

export async function kickPlayer(playerId: PlayerId, targetPlayerId: PlayerId) {
	return post("/api/dev/kick-player", { playerId, targetPlayerId });
}

export async function banPlayer(playerId: PlayerId, targetPlayerId: PlayerId) {
	return post("/api/dev/ban-player", { playerId, targetPlayerId });
}

export async function unbanIp(playerId: PlayerId, ipAddress: string) {
	return post("/api/dev/unban-ip", { playerId, ipAddress });
}

export async function enableSoundDebug(playerId: PlayerId) {
	return post("/api/dev/sound-debug", { playerId });
}

export async function enableZombieDebug(playerId: PlayerId) {
	return post("/api/dev/zombie-debug", { playerId });
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

export async function toggleTownCenterInvincible(playerId: PlayerId) {
	return post("/api/dev/town-center-invincible", { playerId });
}

export async function emitNoise(playerId: PlayerId, x: number, y: number) {
	return post("/api/dev/emit-noise", { playerId, x, y });
}

export async function restartServer(playerId: PlayerId) {
	return post("/api/dev/restart-server", { playerId });
}

export async function shiftTimeOfDay(playerId: PlayerId, hours: number) {
	return post("/api/dev/time-shift", { playerId, hours });
}

export async function setTimeOfDay(playerId: PlayerId, progress: number) {
	return post("/api/dev/time-set", { playerId, progress });
}

async function post(url: string, payload: Record<string, unknown>) {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	return res.json();
}
