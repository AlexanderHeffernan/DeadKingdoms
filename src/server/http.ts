import { createReadStream, promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { makeSnapshot } from "../shared/messages.js";
import { MAX_PLAYERS } from "../shared/config.js";
import { addAdminLog, addPlayer, command, emitDevBang, grantPlayerSoldiers, removePlayer, setWorldTimeOfDay, shiftWorldTime, spawnZombieHorde, toggleTownCenterInvincibility } from "./world.js";
import { Logs } from "../shared/logs.js";
import type { ChangelogStore } from "./changelog.js";
import type { GlobalLeaderboardStore } from "./globalLeaderboard.js";
import type { ServerState } from "./serverState.js";
import type { AdminView, CommandPayload, Player, PlayerId, Snapshot, SnapshotDelta, World } from "../shared/types.js";

const PUBLIC_DIR = new URL("../../public/", import.meta.url);
const CLIENT_BUILD_DIR = new URL("../../dist/client/public/", import.meta.url);
const SOUNDTRACK_DIR = new URL("../../assets/soundtrack/", import.meta.url);
const PROJECT_DIR = new URL("../../", import.meta.url);
const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".mp3": "audio/mpeg",
	".png": "image/png",
	".wav": "audio/wav",
};

// If a client's outgoing buffer exceeds this many bytes we skip sending it
// the next snapshot to avoid runaway memory and "seconds-behind" lag.
const BACKPRESSURE_BYTES = 256 * 1024;
const DISCONNECT_LEAVE_GRACE_MS = 10_000;

const disconnectTimers = new WeakMap<World, Map<PlayerId, NodeJS.Timeout>>();

export type Client = {
	playerId: PlayerId | null;
	sessionToken: string | null;
	res: import("node:http").ServerResponse;
	sentExplored: Set<number> | null;
	adminView: AdminView;
	lastSnapshot: Snapshot | null;
	lastSeq: number;
	replaced?: boolean;
};
let nextSnapshotSeq = 1;

type AuthenticatedPlayer = {
	playerId: PlayerId;
	player: Player;
};

export function createHandler(state: ServerState, clients: Set<Client>, globalLeaderboard: GlobalLeaderboardStore, changelog: ChangelogStore) {
	return async function handler(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
		try {
			const host = req.headers.host || "localhost";
			const url = new URL(req.url ?? "/", `http://${host}`);
			if (req.method === "POST" && url.pathname === "/api/join") return await joinGame(req, res, state.ensureWorld());
			if (req.method === "GET" && url.pathname === "/api/status") return await serverStatus(res, state, globalLeaderboard);
			if (req.method === "GET" && url.pathname === "/api/changelog") return json(res, changelog.current());
			if (req.method === "GET" && url.pathname === "/api/global-leaderboard") return json(res, { entries: await globalLeaderboard.entries() });
			if (req.method === "GET" && url.pathname.startsWith("/api/global-leaderboard/")) return await globalLeaderboardSnapshot(res, globalLeaderboard, url);
			const world = state.currentWorld();
			if (req.method === "GET" && url.pathname === "/api/snapshot") return world ? liveSnapshot(res, world, url) : worldUnavailable(res);
			if (req.method === "GET" && url.pathname === "/events") return world ? streamEvents(req, res, world, clients, globalLeaderboard, url) : worldUnavailable(res);
			if (req.method === "POST" && url.pathname === "/api/log") return await receiveClientLog(req, res, world);
			if (req.method === "POST" && !world && url.pathname.startsWith("/api/")) return worldUnavailable(res);
			if (req.method === "POST" && url.pathname.startsWith("/api/")) {
				if (!world) return worldUnavailable(res);
				if (url.pathname === "/api/dev/admin-access") return await enableAdminAccess(req, res, world);
				if (url.pathname === "/api/dev/disable-admin") return await disableAdminAccess(req, res, world);
				if (url.pathname === "/api/dev/kick-player") return await kickPlayer(req, res, world, globalLeaderboard);
				if (url.pathname === "/api/dev/ban-player") return await banPlayer(req, res, world, globalLeaderboard);
				if (url.pathname === "/api/dev/unban-ip") return await unbanIp(req, res, world);
				if (url.pathname === "/api/dev/full-map-vision") return await enableFullMapVision(req, res, world);
				if (url.pathname === "/api/dev/sound-debug") return await enableSoundDebug(req, res, world);
				if (url.pathname === "/api/dev/zombie-debug") return await enableZombieDebug(req, res, world);
				if (url.pathname === "/api/dev/path-debug") return await enablePathDebug(req, res, world);
				if (url.pathname === "/api/dev/spawn-zombies") return await spawnDevZombies(req, res, world);
				if (url.pathname === "/api/dev/grant-soldiers") return await grantDevSoldiers(req, res, world);
				if (url.pathname === "/api/dev/town-center-invincible") return await toggleTownCenterInvincible(req, res, world);
				if (url.pathname === "/api/dev/emit-noise") return await emitDevNoise(req, res, world);
				if (url.pathname === "/api/dev/time-shift") return await shiftDevTime(req, res, world);
				if (url.pathname === "/api/dev/time-set") return await setDevTime(req, res, world);
				if (url.pathname === "/api/dev/restart-server") return await restartServer(req, res, state, clients, world, globalLeaderboard);
				if (url.pathname === "/api/ping") return await receiveClientPing(req, res, world);
				if (url.pathname === "/api/command") return await receiveCommand(req, res, world);
				if (url.pathname === "/api/leave") return await leaveGame(req, res, world, globalLeaderboard);
			}
			if (req.method === "GET" && url.pathname === "/api/soundtrack") return await listSoundtrack(res);
			if (req.method === "GET" && url.pathname.startsWith("/assets/soundtrack/")) return await serveSoundtrack(req, res, url);
			return await serveStatic(req, res, url);
		} catch (error) {
			if (isRequestAbort(error)) return;
			console.error(`Request failed: ${errorMessage(error)}`);
			if (!res.headersSent && !res.destroyed) return json(res, { ok: false, error: "Internal server error." }, 500);
			res.destroy();
		}
	};
}

async function globalLeaderboardSnapshot(res: import("node:http").ServerResponse, globalLeaderboard: GlobalLeaderboardStore, url: URL) {
	const id = decodeURIComponent(url.pathname.replace("/api/global-leaderboard/", ""));
	if (!id) return json(res, { ok: false, error: "Snapshot not found." }, 404);
	const snapshot = await globalLeaderboard.snapshot(id);
	if (!snapshot) return json(res, { ok: false, error: "Snapshot not found." }, 404);
	const playerId = url.searchParams.get("playerId");
	return json(res, {
		ok: true,
		snapshot: playerId && snapshot.players[playerId]
			? { ...snapshot, playerId }
			: snapshot,
	});
}

function liveSnapshot(res: import("node:http").ServerResponse, world: World, url: URL) {
	const auth = authenticatedPlayer(world, {
		playerId: url.searchParams.get("playerId"),
		sessionToken: url.searchParams.get("sessionToken"),
	});
	if (!auth) return invalidSession(res);
	return json(res, makeSnapshot(world, auth.playerId, null, adminViewFromParam(url.searchParams.get("adminView"))));
}

async function setDevTime(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown; sessionToken?: unknown; progress?: unknown };
	const player = adminPlayer(world, body);
	if (!player) return adminRequired(res);
	const progress = typeof body.progress === "number" && Number.isFinite(body.progress) ? body.progress : 0;
	setWorldTimeOfDay(world, progress);
	json(res, { ok: true });
}

async function shiftDevTime(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown; sessionToken?: unknown; hours?: unknown };
	const player = adminPlayer(world, body);
	if (!player) return adminRequired(res);
	const hours = typeof body.hours === "number" && Number.isFinite(body.hours) ? body.hours : 0;
	shiftWorldTime(world, hours);
	json(res, { ok: true });
}

async function serverStatus(res: import("node:http").ServerResponse, state: ServerState, globalLeaderboard: GlobalLeaderboardStore) {
	const world = state.currentWorld();
	const activePlayers = world ? Object.values(world.players).filter((player) => !player.defeated).length : 0;
	json(res, {
		activePlayers,
		maxPlayers: MAX_PLAYERS,
		deadKingdoms: await globalLeaderboard.deadKingdoms(),
		lastUpdate: await lastUpdateTime(),
		reset: state.resetStatus(activePlayers > 0),
	});
}

function worldUnavailable(res: import("node:http").ServerResponse) {
	return json(res, { ok: false, error: "No active world. Join to start a new map." }, 404);
}

async function lastUpdateTime(): Promise<string | null> {
	const envStamp = process.env.LAST_UPDATE || process.env.BUILD_DATE || process.env.SOURCE_DATE_EPOCH;
	if (envStamp) {
		const date = /^\d+$/.test(envStamp) ? new Date(Number(envStamp) * 1000) : new Date(envStamp);
		if (!Number.isNaN(date.getTime())) return date.toISOString();
	}

	const roots = [PUBLIC_DIR, CLIENT_BUILD_DIR, new URL("package.json", PROJECT_DIR)];
	let latest = 0;
	for (const root of roots) {
		latest = Math.max(latest, await newestMtime(root.pathname));
	}
	return latest > 0 ? new Date(latest).toISOString() : null;
}

async function newestMtime(pathname: string): Promise<number> {
	try {
		const stat = await fs.stat(pathname);
		if (stat.isFile()) return stat.mtimeMs;
		if (!stat.isDirectory()) return 0;
		const entries = await fs.readdir(pathname, { withFileTypes: true });
		const times = await Promise.all(entries.map((entry) => newestMtime(join(pathname, entry.name))));
		return Math.max(stat.mtimeMs, ...times);
	} catch {
		return 0;
	}
}

async function listSoundtrack(res: import("node:http").ServerResponse) {
	try {
		const files = (await fs.readdir(SOUNDTRACK_DIR)).filter((file) => file.toLowerCase().endsWith(".mp3"));
		json(res, { tracks: files.map((file) => `/assets/soundtrack/${encodeURIComponent(file)}`) });
	} catch {
		json(res, { tracks: [] });
	}
}

async function serveSoundtrack(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL) {
	const name = decodeURIComponent(url.pathname.replace("/assets/soundtrack/", ""));
	if (!name || name.includes("/") || name.includes("\\")) {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Not found");
		return;
	}
	const filePath = join(SOUNDTRACK_DIR.pathname, name);
	try {
		const stat = await fs.stat(filePath);
		if (!stat.isFile()) throw new Error("Not a file");
		const type = MIME[extname(filePath) as keyof typeof MIME] || "application/octet-stream";
		const range = parseRange(req.headers.range, stat.size);
		if (range === false) {
			res.writeHead(416, {
				"Content-Type": "text/plain; charset=utf-8",
				"Content-Range": `bytes */${stat.size}`,
				"Accept-Ranges": "bytes",
			});
			res.end("Range not satisfiable");
			return;
		}
		if (range) {
			res.writeHead(206, {
				"Content-Type": type,
				"Content-Length": range.end - range.start + 1,
				"Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
				"Accept-Ranges": "bytes",
			});
			createReadStream(filePath, range).pipe(res);
			return;
		}
		res.writeHead(200, {
			"Content-Type": type,
			"Content-Length": stat.size,
			"Accept-Ranges": "bytes",
		});
		createReadStream(filePath).pipe(res);
	} catch {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Not found");
	}
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | false {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header);
	if (!match) return false;
	let start;
	let end;
	if (match[1] === "") {
		const suffixLength = Number(match[2]);
		if (!Number.isInteger(suffixLength) || suffixLength <= 0) return false;
		start = Math.max(size - suffixLength, 0);
		end = size - 1;
	} else {
		start = Number(match[1]);
		end = match[2] === "" ? size - 1 : Number(match[2]);
	}
	if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
		return false;
	}
	return { start, end: Math.min(end, size - 1) };
}

export function broadcast(world: World, clients: Set<Client>) {
	for (const client of clients) {
		if (client.res.writableEnded || client.res.destroyed) continue;
		if (client.res.writableLength > BACKPRESSURE_BYTES) {
			// Drop this snapshot for this client; they'll catch up on a later tick
			// once their kernel buffer drains.
			continue;
		}
		const snapshot = makeSnapshot(world, client.playerId, client.sentExplored, client.adminView);
		const message = snapshotMessageForClient(client, snapshot);
		const payload = serializeSnapshotMessage(world, client.playerId, message);
		client.res.write(`data: ${payload}\n\n`);
	}
}

function serializeSnapshotMessage(world: World, playerId: PlayerId | null, message: Snapshot | SnapshotDelta) {
	const kind = message.type === "snapshot" ? "full" : "delta";
	const firstPayload = JSON.stringify(message);
	recordSnapshotBytes(world, playerId, firstPayload.length, kind);
	annotateAdminPlayerSnapshot(message, playerId, firstPayload.length, kind);
	const payload = JSON.stringify(message);
	recordSnapshotBytes(world, playerId, payload.length, kind);
	return payload;
}

function annotateAdminPlayerSnapshot(message: Snapshot | SnapshotDelta, playerId: PlayerId | null, bytes: number, kind: "full" | "delta") {
	if (!playerId || !message.admin?.players) return;
	const player = message.admin.players.find((entry) => entry.id === playerId);
	if (!player) return;
	player.lastSnapshotBytes = bytes;
	player.lastSnapshotKind = kind;
}

function snapshotMessageForClient(client: Client, snapshot: Snapshot): Snapshot | SnapshotDelta {
	const seq = nextSnapshotSeq++;
	// Snapshots contain nested arrays/objects copied from live world entities
	// (building queues, unit commands, resources, etc.). Store a JSON-detached
	// copy for future diffing so later simulation mutations cannot rewrite the
	// client's "previous" snapshot and hide deltas.
	const stableSnapshot = stableSnapshotForDiff(snapshot);
	if (!client.lastSnapshot) {
		snapshot.seq = seq;
		stableSnapshot.seq = seq;
		client.lastSnapshot = stableSnapshot;
		client.lastSeq = seq;
		return snapshot;
	}
	const delta = makeSnapshotDelta(client.lastSnapshot, stableSnapshot, client.lastSeq, seq);
	client.lastSnapshot = stableSnapshot;
	client.lastSeq = seq;
	return delta;
}

function stableSnapshotForDiff(snapshot: Snapshot): Snapshot {
	return JSON.parse(JSON.stringify(snapshot)) as Snapshot;
}

export function makeSnapshotDelta(previous: Snapshot, current: Snapshot, baseSeq: number, seq: number): SnapshotDelta {
	return {
		type: "snapshot-delta",
		baseSeq,
		seq,
		now: current.now,
		playerId: current.playerId,
		players: diffRecord(previous.players, current.players),
		units: diffRecord(previous.units, current.units),
		buildings: diffRecord(previous.buildings, current.buildings),
		resources: diffRecord(previous.resources, current.resources),
		ruins: diffRecord(previous.ruins, current.ruins),
		corpses: diffRecord(previous.corpses, current.corpses),
		visibility: current.visibility,
		dayNight: current.dayNight,
		leaderboard: current.leaderboard,
		notices: current.notices,
		hornSounds: current.hornSounds,
		soundDebug: current.soundDebug,
		pathDebug: current.pathDebug,
		serverPerf: current.serverPerf,
		admin: current.admin,
	};
}

function diffRecord<T>(previous: Record<string, T>, current: Record<string, T>) {
	const updated: Record<string, T> = {};
	const removed: string[] = [];
	for (const [id, value] of Object.entries(current)) {
		if (!hasOwn(previous, id) || JSON.stringify(previous[id]) !== JSON.stringify(value)) updated[id] = value;
	}
	for (const id of Object.keys(previous)) {
		if (!hasOwn(current, id)) removed.push(id);
	}
	return { updated, removed };
}

function hasOwn<T>(record: Record<string, T>, key: string) {
	return Object.prototype.hasOwnProperty.call(record, key);
}

function recordSnapshotBytes(world: World, playerId: PlayerId | null, bytes: number, kind: "full" | "delta") {
	const player = playerId ? world.players[playerId] : null;
	if (!player?.connection) return;
	player.connection.lastSnapshotBytes = bytes;
	player.connection.lastSnapshotKind = kind;
}

async function joinGame(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const ipAddress = clientIp(req);
	if (ipAddress && (world.bannedIpAddresses ?? []).includes(ipAddress)) return json(res, { ok: false, error: "This IP address is banned from this game." }, 403);
	const active = Object.values(world.players).filter((player) => !player.defeated).length;
	if (active >= MAX_PLAYERS) return json(res, { ok: false, error: "Server is full." }, 403);
	const body = (await readJson(req)) as { name?: unknown; color?: unknown };
	const name = playerDisplayName(typeof body.name === "string" ? body.name : "Player");
	if (isPlayerNameInUse(world, name)) {
		return json(res, { ok: false, error: "Username already in use" }, 409);
	}
	const color = typeof body.color === "string" ? body.color : null;
	const playerId = addPlayer(world, name, color);
	const sessionToken = newSessionToken();
	world.players[playerId]!.sessionToken = sessionToken;
	recordPlayerConnection(world.players[playerId], ipAddress, false);
	json(res, { ok: true, playerId, sessionToken });
}

function playerDisplayName(name: string) {
	return name.trim().slice(0, 18) || "Player";
}

function isPlayerNameInUse(world: World, name: string) {
	const normalized = name.toLocaleLowerCase();
	return Object.values(world.players).some((player) => !player.defeated && player.name.toLocaleLowerCase() === normalized);
}

async function enableAdminAccess(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown; sessionToken?: unknown; secret?: unknown };
	const auth = authenticatedPlayer(world, body);
	if (!auth) return invalidSession(res);
	if (typeof body.secret !== "string" || !isAdminSecret(body.secret)) {
		return json(res, { ok: false, error: "Invalid admin secret." }, 403);
	}
	const player = auth.player;
	if (player.adminLevel) {
		delete player.adminLevel;
		player.godMode = false;
		player.soundDebug = false;
		player.zombieDebug = false;
		player.pathDebug = false;
		delete player._visCache;
		return json(res, { ok: true, adminLevel: null, enabled: false });
	}
	player.adminLevel = "admin";
	json(res, { ok: true, adminLevel: player.adminLevel, enabled: true });
}

async function disableAdminAccess(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown; sessionToken?: unknown };
	const auth = authenticatedPlayer(world, body);
	if (!auth) return invalidSession(res);
	const player = auth.player;
	if (!player.adminLevel) return adminRequired(res);
	delete player.adminLevel;
	player.godMode = false;
	player.soundDebug = false;
	player.zombieDebug = false;
	player.pathDebug = false;
	delete player._visCache;
	Logs.log(`${player.name} disabled admin mode.`);
	json(res, { ok: true });
}

async function enableFullMapVision(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown; sessionToken?: unknown };
	const auth = authenticatedPlayer(world, body);
	if (!auth) return invalidSession(res);
	const player = auth.player;
	if (!player.adminLevel) return adminRequired(res);
	player.godMode = !player.godMode;
	delete player._visCache;
	Logs.log(`${player.name} ${player.godMode ? "enabled" : "disabled"} full-map admin vision.`);
	json(res, { ok: true, enabled: player.godMode });
}

async function enableSoundDebug(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown; sessionToken?: unknown };
	const auth = authenticatedPlayer(world, body);
	if (!auth) return invalidSession(res);
	const player = auth.player;
	if (!player.adminLevel) return adminRequired(res);
	player.soundDebug = !player.soundDebug;
	json(res, { ok: true, enabled: player.soundDebug });
}

async function enableZombieDebug(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown; sessionToken?: unknown };
	const auth = authenticatedPlayer(world, body);
	if (!auth) return invalidSession(res);
	const player = auth.player;
	if (!player.adminLevel) return adminRequired(res);
	player.zombieDebug = !player.zombieDebug;
	json(res, { ok: true, enabled: player.zombieDebug });
}

async function kickPlayer(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World, globalLeaderboard: GlobalLeaderboardStore) {
	const body = (await readJson(req)) as { playerId?: unknown; sessionToken?: unknown; targetPlayerId?: unknown };
	const admin = adminPlayer(world, body);
	if (!admin) return adminRequired(res);
	if (typeof body.targetPlayerId !== "string") return json(res, { ok: false, error: "Player not found." }, 404);
	if (!world.players[body.targetPlayerId]) return json(res, { ok: false, error: "Player not found." }, 404);
	await globalLeaderboard.trackWorldPeaks(world, { playerId: body.targetPlayerId, force: true });
	removePlayer(world, body.targetPlayerId);
	Logs.log(`${admin.name} kicked a player.`);
	json(res, { ok: true });
}

async function banPlayer(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World, globalLeaderboard: GlobalLeaderboardStore) {
	const body = (await readJson(req)) as { playerId?: unknown; sessionToken?: unknown; targetPlayerId?: unknown };
	const admin = adminPlayer(world, body);
	if (!admin) return adminRequired(res);
	if (typeof body.targetPlayerId !== "string") return json(res, { ok: false, error: "Player not found." }, 404);
	const target = world.players[body.targetPlayerId];
	if (!target) return json(res, { ok: false, error: "Player not found." }, 404);
	const ipAddress = target.connection?.ipAddress;
	if (!ipAddress) return json(res, { ok: false, error: "No IP address recorded for that player." }, 400);
	world.bannedIpAddresses ??= [];
	if (!world.bannedIpAddresses.includes(ipAddress)) world.bannedIpAddresses.push(ipAddress);
	await globalLeaderboard.trackWorldPeaks(world, { playerId: body.targetPlayerId, force: true });
	removePlayer(world, body.targetPlayerId);
	Logs.log(`${admin.name} banned ${ipAddress}.`);
	json(res, { ok: true, ipAddress });
}

async function unbanIp(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown; sessionToken?: unknown; ipAddress?: unknown };
	const admin = adminPlayer(world, body);
	if (!admin) return adminRequired(res);
	if (typeof body.ipAddress !== "string") return json(res, { ok: false, error: "IP address is required." }, 400);
	world.bannedIpAddresses = (world.bannedIpAddresses ?? []).filter((ipAddress) => ipAddress !== body.ipAddress);
	Logs.log(`${admin.name} unbanned ${body.ipAddress}.`);
	json(res, { ok: true });
}

async function enablePathDebug(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown; sessionToken?: unknown };
	const player = adminPlayer(world, body);
	if (!player) return adminRequired(res);
	player.pathDebug = true;
	json(res, { ok: true });
}

async function spawnDevZombies(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown; sessionToken?: unknown; count?: unknown };
	const auth = authenticatedPlayer(world, body);
	if (!auth) return invalidSession(res);
	const player = auth.player;
	if (!player.adminLevel) return adminRequired(res);
	const count = typeof body.count === "number" ? body.count : 500;
	const spawned = spawnZombieHorde(world, auth.playerId, count);
	Logs.log(`${player.name} deployed a hostile stress horde of ${spawned}.`);
	json(res, { ok: true, spawned });
}

async function grantDevSoldiers(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown; sessionToken?: unknown; count?: unknown };
	const auth = authenticatedPlayer(world, body);
	if (!auth) return invalidSession(res);
	const player = auth.player;
	if (!player.adminLevel) return adminRequired(res);
	const count = typeof body.count === "number" ? body.count : 100;
	const granted = grantPlayerSoldiers(world, auth.playerId, count);
	Logs.log(`${player.name} granted ${granted} soldiers.`);
	json(res, { ok: true, granted });
}

async function toggleTownCenterInvincible(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown; sessionToken?: unknown };
	const auth = authenticatedPlayer(world, body);
	if (!auth) return invalidSession(res);
	const player = auth.player;
	if (!player.adminLevel) return adminRequired(res);
	const invincible = toggleTownCenterInvincibility(world, auth.playerId);
	if (invincible === null) return json(res, { ok: false, error: "No town center found." }, 404);
	Logs.log(`${player.name} ${invincible ? "enabled" : "disabled"} town center invincibility.`);
	json(res, { ok: true, invincible });
}

async function emitDevNoise(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown; sessionToken?: unknown; x?: unknown; y?: unknown };
	const auth = authenticatedPlayer(world, body);
	if (!auth) return invalidSession(res);
	const player = auth.player;
	if (!player.adminLevel) return adminRequired(res);
	if (typeof body.x !== "number" || typeof body.y !== "number") return json(res, { ok: false, error: "Noise position is required." }, 400);
	emitDevBang(world, body.x, body.y);
	json(res, { ok: true });
}

async function restartServer(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, state: ServerState, clients: Set<Client>, world: World, globalLeaderboard: GlobalLeaderboardStore) {
	const body = (await readJson(req)) as { playerId?: unknown; sessionToken?: unknown };
	const auth = authenticatedPlayer(world, body);
	if (!auth) return invalidSession(res);
	const player = auth.player;
	if (!player.adminLevel) return adminRequired(res);
	await globalLeaderboard.publishWorldPeaks(state.restartNow(player.name));
	json(res, { ok: true });
	for (const client of clients) {
		client.res.end();
	}
	clients.clear();
}

async function receiveClientLog(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World | null) {
	const body = (await readJson(req)) as { playerId?: unknown; sessionToken?: unknown; message?: unknown };
	if (typeof body.message !== "string") return json(res, { ok: false, error: "Log message is required." }, 400);
	const player = world && typeof body.playerId === "string" ? authenticatedPlayer(world, body)?.player ?? null : null;
	const source = player?.name || "client";
	if (world) addAdminLog(world, source, body.message);
	json(res, { ok: true });
}

async function receiveClientPing(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown; sessionToken?: unknown; pingMs?: unknown };
	const auth = authenticatedPlayer(world, body);
	if (!auth) return invalidSession(res);
	const player = auth.player;
	const pingMs = typeof body.pingMs === "number" ? body.pingMs : null;
	if (!player.connection || pingMs === null) return json(res, { ok: false }, 400);
	player.connection.pingMs = Math.max(0, Math.min(60000, Math.round(pingMs)));
	player.connection.lastSeenAt = Date.now();
	json(res, { ok: true });
}

async function receiveCommand(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as Partial<CommandPayload> & { sessionToken?: unknown };
	const auth = authenticatedPlayer(world, body);
	if (!auth) return invalidSession(res);
	const result = command(world, auth.playerId, { ...body, playerId: auth.playerId } as CommandPayload);
	json(res, result, result.ok ? 200 : 400);
}

async function leaveGame(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World, globalLeaderboard: GlobalLeaderboardStore) {
	const body = (await readJson(req)) as { playerId?: unknown; sessionToken?: unknown };
	const auth = authenticatedPlayer(world, body);
	if (!auth) return invalidSession(res);
	cancelDisconnectLeave(world, auth.playerId);
	await globalLeaderboard.trackWorldPeaks(world, { playerId: auth.playerId, force: true });
	await globalLeaderboard.countDeadKingdom();
	removePlayer(world, auth.playerId);
	json(res, { ok: true });
}

function streamEvents(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World, clients: Set<Client>, globalLeaderboard: GlobalLeaderboardStore, url: URL) {
	const playerIdParam = url.searchParams.get("playerId");
	const sessionToken = url.searchParams.get("sessionToken");
	const auth = authenticatedPlayer(world, { playerId: playerIdParam, sessionToken });
	if (!auth) return invalidSession(res);
	const playerId = auth.playerId;
	const adminView = adminViewFromParam(url.searchParams.get("adminView"));
	cancelDisconnectLeave(world, playerId);
	closeExistingClientStreams(clients, world, playerId);
	recordPlayerConnection(auth.player, clientIp(req), true);
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	// sentExplored is null for the first snapshot (server then sends the full
	// explored set). After that we populate the Set so subsequent snapshots
	// only carry the new tiles in `exploredDelta`.
	const client: Client = { playerId, sessionToken, res, sentExplored: null, adminView, lastSnapshot: null, lastSeq: 0 };
	clients.add(client);
	const initialSnapshot = makeSnapshot(world, playerId, null, adminView);
	const initialMessage = snapshotMessageForClient(client, initialSnapshot);
	const initialPayload = serializeSnapshotMessage(world, playerId, initialMessage);
	res.write(`data: ${initialPayload}\n\n`);
	client.sentExplored = new Set(auth.player.explored || []);
	req.on("close", () => {
		clients.delete(client);
		const currentPlayer = world.players[playerId];
		if (currentPlayer?.connection) {
			currentPlayer.connection.streamCount = activeStreamCount(clients, playerId);
			currentPlayer.connection.lastSeenAt = Date.now();
		}
		if (!client.replaced && activeStreamCount(clients, playerId) === 0) {
			scheduleDisconnectLeave(world, clients, globalLeaderboard, playerId, sessionToken);
		}
	});
}

function isAdminSecret(secret: string) {
	const configuredSecrets = [
		process.env.DEV_ADMIN_SECRET,
		// Backward-compatible aliases for existing deployments that used the old
		// full-admin/operator secrets before admin roles were collapsed.
		process.env.DEV_OPERATOR_SECRET,
		process.env.DEV_GOD_MODE_SECRET,
	].filter((value): value is string => !!value);
	return configuredSecrets.some((configuredSecret) => secret.endsWith(configuredSecret));
}

function adminViewFromParam(value: string | null): AdminView {
	if (
		value === "closed" ||
		value === "popup" ||
		value === "overview" ||
		value === "performance" ||
		value === "players" ||
		value === "logs" ||
		value === "devCommands" ||
		value === "bans"
	) return value;
	return "popup";
}

function adminPlayer(world: World, credentials: { playerId?: unknown; sessionToken?: unknown }): Player | null {
	const player = authenticatedPlayer(world, credentials)?.player;
	return player?.adminLevel ? player : null;
}

function adminRequired(res: import("node:http").ServerResponse) {
	return json(res, { ok: false, error: "Admin access is required." }, 403);
}

function authenticatedPlayer(world: World, credentials: { playerId?: unknown; sessionToken?: unknown }): AuthenticatedPlayer | null {
	if (typeof credentials.playerId !== "string" || typeof credentials.sessionToken !== "string") return null;
	const player = world.players[credentials.playerId];
	if (!player || player.sessionToken !== credentials.sessionToken) return null;
	return { playerId: credentials.playerId, player };
}

function invalidSession(res: import("node:http").ServerResponse) {
	return json(res, { ok: false, error: "Invalid or expired player session." }, 403);
}

function newSessionToken() {
	return randomBytes(32).toString("base64url");
}

function closeExistingClientStreams(clients: Set<Client>, world: World, playerId: PlayerId) {
	for (const client of [...clients]) {
		if (client.playerId !== playerId) continue;
		client.replaced = true;
		clients.delete(client);
		client.res.end();
	}
	const player = world.players[playerId];
	if (player?.connection) player.connection.streamCount = activeStreamCount(clients, playerId);
}

function cancelDisconnectLeave(world: World, playerId: PlayerId) {
	const timer = disconnectTimers.get(world)?.get(playerId);
	if (!timer) return;
	clearTimeout(timer);
	disconnectTimers.get(world)?.delete(playerId);
}

function scheduleDisconnectLeave(world: World, clients: Set<Client>, globalLeaderboard: GlobalLeaderboardStore, playerId: PlayerId, sessionToken: string | null) {
	cancelDisconnectLeave(world, playerId);
	let timers = disconnectTimers.get(world);
	if (!timers) {
		timers = new Map();
		disconnectTimers.set(world, timers);
	}
	const timer = setTimeout(() => {
		void removeDisconnectedPlayer(world, clients, globalLeaderboard, playerId, sessionToken).catch((error: unknown) => {
			console.error(`Could not remove disconnected player: ${errorMessage(error)}`);
		});
	}, DISCONNECT_LEAVE_GRACE_MS);
	timer.unref?.();
	timers.set(playerId, timer);
}

async function removeDisconnectedPlayer(world: World, clients: Set<Client>, globalLeaderboard: GlobalLeaderboardStore, playerId: PlayerId, sessionToken: string | null) {
	disconnectTimers.get(world)?.delete(playerId);
	const player = world.players[playerId];
	if (!player || player.sessionToken !== sessionToken || activeStreamCount(clients, playerId) > 0) return;
	Logs.log(`${player.name} lost connection and left the world.`);
	await globalLeaderboard.trackWorldPeaks(world, { playerId, force: true });
	await globalLeaderboard.countDeadKingdom();
	removePlayer(world, playerId);
}

function activeStreamCount(clients: Set<Client>, playerId: PlayerId) {
	let count = 0;
	for (const client of clients) {
		if (client.playerId === playerId) count += 1;
	}
	return count;
}

function recordPlayerConnection(player: Player | null | undefined, ipAddress: string | null, openedStream: boolean) {
	if (!player) return;
	const now = Date.now();
	if (!player.connection) {
		player.connection = {
			ipAddress,
			connectedAt: now,
			lastSeenAt: now,
			streamCount: 0,
		};
	} else {
		player.connection.ipAddress = ipAddress || player.connection.ipAddress;
		player.connection.lastSeenAt = now;
	}
	if (openedStream) player.connection.streamCount += 1;
}

function clientIp(req: import("node:http").IncomingMessage): string | null {
	const forwardedFor = req.headers["x-forwarded-for"];
	const forwardedIp = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
	const ipAddress = forwardedIp?.split(",")[0]?.trim() || req.socket.remoteAddress || null;
	if (!ipAddress) return null;
	return ipAddress.startsWith("::ffff:") ? ipAddress.slice(7) : ipAddress;
}

async function serveStatic(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL) {
	const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
	const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
	const rootDir = safePath.startsWith("/js/") ? CLIENT_BUILD_DIR : PUBLIC_DIR;
	const filePath = join(rootDir.pathname, safePath);
	try {
		const stat = await fs.stat(filePath);
		if (!stat.isFile()) throw new Error("Not a file");
		res.writeHead(200, {
			"Content-Type": MIME[extname(filePath) as keyof typeof MIME] || "application/octet-stream",
			"Cache-Control": cacheControl(filePath),
		});
		createReadStream(filePath).pipe(res);
	} catch {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Not found");
	}
}

function cacheControl(filePath: string) {
	const ext = extname(filePath);
	if (ext === ".html" || ext === ".css" || ext === ".js" || ext === ".wav") return "no-cache";
	return "public, max-age=86400";
}

async function readJson(req: import("node:http").IncomingMessage): Promise<unknown> {
	let data = "";
	for await (const chunk of req) data += chunk;
	return data ? JSON.parse(data) : {};
}

function isRequestAbort(error: unknown) {
	return error instanceof Error && (error.message === "aborted" || (error as NodeJS.ErrnoException).code === "ECONNRESET");
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function json(res: import("node:http").ServerResponse, payload: unknown, status = 200) {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(payload));
}
