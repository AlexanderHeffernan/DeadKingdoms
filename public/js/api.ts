import type { CommandPayload, CommandResult, GlobalLeaderboardEntry, LeaderboardPreviewSnapshot, PlayerId } from "../../src/shared/types.js";

export type SessionCredentials = {
	playerId: PlayerId;
	sessionToken: string;
};

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

export async function join(name: string, color: string): Promise<{ ok: boolean; playerId?: PlayerId; sessionToken?: string; error?: string }> {
	return post("/api/join", { name, color });
}

export async function sendCommand(payload: CommandPayload, sessionToken: string): Promise<CommandResult> {
	return post("/api/command", { ...payload, sessionToken } as unknown as Record<string, unknown>) as Promise<CommandResult>;
}

export async function leave(credentials: SessionCredentials) {
	return post("/api/leave", credentials);
}

export async function enableAdminAccess(credentials: SessionCredentials, secret: string) {
	return post("/api/dev/admin-access", { ...credentials, secret });
}

export async function disableAdminMode(credentials: SessionCredentials) {
	return post("/api/dev/disable-admin", credentials);
}

export async function enableFullMapVision(credentials: SessionCredentials) {
	return post("/api/dev/full-map-vision", credentials);
}

export async function kickPlayer(credentials: SessionCredentials, targetPlayerId: PlayerId) {
	return post("/api/dev/kick-player", { ...credentials, targetPlayerId });
}

export async function banPlayer(credentials: SessionCredentials, targetPlayerId: PlayerId) {
	return post("/api/dev/ban-player", { ...credentials, targetPlayerId });
}

export async function unbanIp(credentials: SessionCredentials, ipAddress: string) {
	return post("/api/dev/unban-ip", { ...credentials, ipAddress });
}

export async function enableSoundDebug(credentials: SessionCredentials) {
	return post("/api/dev/sound-debug", credentials);
}

export async function enableZombieDebug(credentials: SessionCredentials) {
	return post("/api/dev/zombie-debug", credentials);
}

export async function enablePathDebug(credentials: SessionCredentials) {
	return post("/api/dev/path-debug", credentials);
}

export async function spawnZombieHorde(credentials: SessionCredentials, count = 500) {
	return post("/api/dev/spawn-zombies", { ...credentials, count });
}

export async function logClientMessage(credentials: SessionCredentials | null, message: string) {
	return post("/api/log", { ...credentials, message });
}

export async function reportPing(credentials: SessionCredentials, pingMs: number) {
	return post("/api/ping", { ...credentials, pingMs });
}

export async function grantSoldiers(credentials: SessionCredentials, count = 100) {
	return post("/api/dev/grant-soldiers", { ...credentials, count });
}

export async function toggleTownCenterInvincible(credentials: SessionCredentials) {
	return post("/api/dev/town-center-invincible", credentials);
}

export async function emitNoise(credentials: SessionCredentials, x: number, y: number) {
	return post("/api/dev/emit-noise", { ...credentials, x, y });
}

export async function restartServer(credentials: SessionCredentials) {
	return post("/api/dev/restart-server", credentials);
}

export async function shiftTimeOfDay(credentials: SessionCredentials, hours: number) {
	return post("/api/dev/time-shift", { ...credentials, hours });
}

export async function setTimeOfDay(credentials: SessionCredentials, progress: number) {
	return post("/api/dev/time-set", { ...credentials, progress });
}

async function post(url: string, payload: Record<string, unknown>) {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	return res.json();
}
