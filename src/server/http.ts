import { createReadStream, promises as fs } from "node:fs";
import { extname, join, normalize } from "node:path";
import { makeSnapshot } from "../shared/messages.js";
import { MAX_PLAYERS } from "../shared/config.js";
import { addAdminLog, addPlayer, command, emitDevBang, grantPlayerSoldiers, removePlayer, spawnZombieHorde, toggleTownCenterInvincibility } from "./world.js";
import { Logs } from "../shared/logs.js";
import type { ServerState } from "./serverState.js";
import type { AdminLevel, CommandPayload, Player, PlayerId, World } from "../shared/types.js";

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
	".wav": "audio/wav",
};

// If a client's outgoing buffer exceeds this many bytes we skip sending it
// the next snapshot to avoid runaway memory and "seconds-behind" lag.
const BACKPRESSURE_BYTES = 256 * 1024;

export type Client = { playerId: PlayerId | null; res: import("node:http").ServerResponse; sentExplored: Set<number> | null };

export function createHandler(state: ServerState, clients: Set<Client>) {
	return async function handler(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
		const host = req.headers.host || "localhost";
		const url = new URL(req.url ?? "/", `http://${host}`);
		if (req.method === "POST" && url.pathname === "/api/join") return joinGame(req, res, state.ensureWorld());
		if (req.method === "GET" && url.pathname === "/api/status") return serverStatus(res, state);
		const world = state.currentWorld();
		if (req.method === "GET" && url.pathname === "/api/snapshot") return world ? json(res, makeSnapshot(world)) : worldUnavailable(res);
		if (req.method === "GET" && url.pathname === "/events") return world ? streamEvents(req, res, world, clients, url) : worldUnavailable(res);
		if (req.method === "POST" && url.pathname === "/api/log") return receiveClientLog(req, res, world);
		if (req.method === "POST" && !world && url.pathname.startsWith("/api/")) return worldUnavailable(res);
		if (req.method === "POST" && url.pathname.startsWith("/api/")) {
			if (!world) return worldUnavailable(res);
			if (url.pathname === "/api/dev/admin-access") return enableAdminAccess(req, res, world);
			if (url.pathname === "/api/dev/full-map-vision") return enableFullMapVision(req, res, world);
			if (url.pathname === "/api/dev/sound-debug") return enableSoundDebug(req, res, world);
			if (url.pathname === "/api/dev/zombie-debug") return enableZombieDebug(req, res, world);
			if (url.pathname === "/api/dev/path-debug") return enablePathDebug(req, res, world);
			if (url.pathname === "/api/dev/spawn-zombies") return spawnDevZombies(req, res, world);
			if (url.pathname === "/api/dev/grant-soldiers") return grantDevSoldiers(req, res, world);
			if (url.pathname === "/api/dev/town-center-invincible") return toggleTownCenterInvincible(req, res, world);
			if (url.pathname === "/api/dev/emit-noise") return emitDevNoise(req, res, world);
			if (url.pathname === "/api/dev/restart-server") return restartServer(req, res, state, clients, world);
			if (url.pathname === "/api/ping") return receiveClientPing(req, res, world);
			if (url.pathname === "/api/command") return receiveCommand(req, res, world);
			if (url.pathname === "/api/leave") return leaveGame(req, res, world);
		}
		if (req.method === "GET" && url.pathname === "/api/soundtrack") return listSoundtrack(res);
		if (req.method === "GET" && url.pathname.startsWith("/assets/soundtrack/")) return serveSoundtrack(req, res, url);
		return serveStatic(req, res, url);
	};
}

async function serverStatus(res: import("node:http").ServerResponse, state: ServerState) {
	const world = state.currentWorld();
	const activePlayers = world ? Object.values(world.players).filter((player) => !player.defeated).length : 0;
	json(res, {
		activePlayers,
		maxPlayers: MAX_PLAYERS,
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
		const payload = JSON.stringify(makeSnapshot(world, client.playerId, client.sentExplored));
		client.res.write(`data: ${payload}\n\n`);
	}
}

async function joinGame(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const active = Object.values(world.players).filter((player) => !player.defeated).length;
	if (active >= MAX_PLAYERS) return json(res, { ok: false, error: "Server is full." }, 403);
	const body = (await readJson(req)) as { name?: unknown; color?: unknown };
	const name = typeof body.name === "string" ? body.name : "Player";
	const color = typeof body.color === "string" ? body.color : null;
	const playerId = addPlayer(world, name, color);
	recordPlayerConnection(world.players[playerId], clientIp(req), false);
	json(res, { ok: true, playerId });
}

async function enableAdminAccess(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown; secret?: unknown };
	const adminLevel = typeof body.secret === "string" ? adminLevelForSecret(body.secret) : null;
	if (typeof body.playerId !== "string" || !adminLevel) {
		return json(res, { ok: false, error: "Invalid admin secret." }, 403);
	}
	const player = world.players[body.playerId];
	if (!player) return json(res, { ok: false, error: "Player not found." }, 404);
	player.adminLevel = adminLevel;
	json(res, { ok: true, adminLevel });
}

async function enableFullMapVision(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown };
	const player = typeof body.playerId === "string" ? world.players[body.playerId] : null;
	if (!player) return json(res, { ok: false, error: "Player not found." }, 404);
	if (!player.adminLevel) return json(res, { ok: false, error: "Admin access is required." }, 403);
	player.godMode = true;
	delete player._visCache;
	Logs.log(`${player.name} enabled full-map admin vision.`);
	json(res, { ok: true });
}

async function enableSoundDebug(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown };
	if (typeof body.playerId !== "string") return json(res, { ok: false, error: "Player not found." }, 404);
	const player = world.players[body.playerId];
	if (!player) return json(res, { ok: false, error: "Player not found." }, 404);
	if (!player.adminLevel) return json(res, { ok: false, error: "Admin access is required." }, 403);
	player.soundDebug = true;
	json(res, { ok: true });
}

async function enableZombieDebug(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown };
	if (typeof body.playerId !== "string") return json(res, { ok: false, error: "Player not found." }, 404);
	const player = world.players[body.playerId];
	if (!player) return json(res, { ok: false, error: "Player not found." }, 404);
	if (!player.adminLevel) return json(res, { ok: false, error: "Admin access is required." }, 403);
	player.zombieDebug = true;
	json(res, { ok: true });
}

async function enablePathDebug(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const secret = process.env.DEV_PATHFINDING_DEBUG_SECRET || "revealpathfinding";
	const body = (await readJson(req)) as { playerId?: unknown; secret?: unknown };
	if (typeof body.playerId !== "string" || typeof body.secret !== "string" || !body.secret.endsWith(secret)) {
		return json(res, { ok: false, error: "Invalid pathfinding debug secret." }, 403);
	}
	const player = world.players[body.playerId];
	if (!player) return json(res, { ok: false, error: "Player not found." }, 404);
	player.pathDebug = true;
	json(res, { ok: true });
}

async function spawnDevZombies(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown; count?: unknown };
	if (typeof body.playerId !== "string") return json(res, { ok: false, error: "Player not found." }, 404);
	const player = world.players[body.playerId];
	if (!player) return json(res, { ok: false, error: "Player not found." }, 404);
	if (!player.adminLevel) return json(res, { ok: false, error: "Admin access is required." }, 403);
	const count = typeof body.count === "number" ? body.count : 500;
	const spawned = spawnZombieHorde(world, body.playerId, count);
	Logs.log(`${player.name} deployed a hostile stress horde of ${spawned}.`);
	json(res, { ok: true, spawned });
}

async function grantDevSoldiers(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown; count?: unknown };
	if (typeof body.playerId !== "string") return json(res, { ok: false, error: "Player not found." }, 404);
	const player = world.players[body.playerId];
	if (!player) return json(res, { ok: false, error: "Player not found." }, 404);
	if (!player.adminLevel) return json(res, { ok: false, error: "Admin access is required." }, 403);
	const count = typeof body.count === "number" ? body.count : 100;
	const granted = grantPlayerSoldiers(world, body.playerId, count);
	Logs.log(`${player.name} granted ${granted} soldiers.`);
	json(res, { ok: true, granted });
}

async function toggleTownCenterInvincible(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown };
	if (typeof body.playerId !== "string") return json(res, { ok: false, error: "Player not found." }, 404);
	const player = world.players[body.playerId];
	if (!player) return json(res, { ok: false, error: "Player not found." }, 404);
	if (!player.adminLevel) return json(res, { ok: false, error: "Admin access is required." }, 403);
	const invincible = toggleTownCenterInvincibility(world, body.playerId);
	if (invincible === null) return json(res, { ok: false, error: "No town center found." }, 404);
	Logs.log(`${player.name} ${invincible ? "enabled" : "disabled"} town center invincibility.`);
	json(res, { ok: true, invincible });
}

async function emitDevNoise(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown; x?: unknown; y?: unknown };
	if (typeof body.playerId !== "string") return json(res, { ok: false, error: "Player not found." }, 404);
	const player = world.players[body.playerId];
	if (!player) return json(res, { ok: false, error: "Player not found." }, 404);
	if (!player.adminLevel) return json(res, { ok: false, error: "Admin access is required." }, 403);
	if (typeof body.x !== "number" || typeof body.y !== "number") return json(res, { ok: false, error: "Noise position is required." }, 400);
	emitDevBang(world, body.x, body.y);
	json(res, { ok: true });
}

async function restartServer(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, state: ServerState, clients: Set<Client>, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown };
	if (typeof body.playerId !== "string") return json(res, { ok: false, error: "Player not found." }, 404);
	const player = world.players[body.playerId];
	if (!player) return json(res, { ok: false, error: "Player not found." }, 404);
	if (!player.adminLevel) return json(res, { ok: false, error: "Admin access is required." }, 403);
	state.restartNow(player.name);
	json(res, { ok: true });
	for (const client of clients) {
		client.res.end();
	}
	clients.clear();
}

async function receiveClientLog(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World | null) {
	const body = (await readJson(req)) as { playerId?: unknown; message?: unknown };
	if (typeof body.message !== "string") return json(res, { ok: false, error: "Log message is required." }, 400);
	const player = world && typeof body.playerId === "string" ? world.players[body.playerId] : null;
	const source = player?.name || "client";
	if (world) addAdminLog(world, source, body.message);
	json(res, { ok: true });
}

async function receiveClientPing(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown; pingMs?: unknown };
	const player = typeof body.playerId === "string" ? world.players[body.playerId] : null;
	const pingMs = typeof body.pingMs === "number" ? body.pingMs : null;
	if (!player || !player.connection || pingMs === null) return json(res, { ok: false }, 400);
	player.connection.pingMs = Math.max(0, Math.min(60000, Math.round(pingMs)));
	player.connection.lastSeenAt = Date.now();
	json(res, { ok: true });
}

async function receiveCommand(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as Partial<CommandPayload>;
	const result = command(world, body.playerId as PlayerId, body as CommandPayload);
	json(res, result, result.ok ? 200 : 400);
}

async function leaveGame(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
	const body = (await readJson(req)) as { playerId?: unknown };
	if (typeof body.playerId === "string") removePlayer(world, body.playerId);
	json(res, { ok: true });
}

function streamEvents(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World, clients: Set<Client>, url: URL) {
	const playerIdParam = url.searchParams.get("playerId");
	const playerId = playerIdParam ?? null;
	const player = playerId ? world.players[playerId] : null;
	recordPlayerConnection(player, clientIp(req), true);
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	// sentExplored is null for the first snapshot (server then sends the full
	// explored set). After that we populate the Set so subsequent snapshots
	// only carry the new tiles in `exploredDelta`.
	const client: Client = { playerId, res, sentExplored: null };
	clients.add(client);
	res.write(`data: ${JSON.stringify(makeSnapshot(world, playerId, null))}\n\n`);
	client.sentExplored = new Set(playerId ? world.players[playerId]?.explored || [] : []);
	req.on("close", () => {
		clients.delete(client);
		const currentPlayer = playerId ? world.players[playerId] : null;
		if (currentPlayer?.connection) {
			currentPlayer.connection.streamCount = Math.max(0, currentPlayer.connection.streamCount - 1);
			currentPlayer.connection.lastSeenAt = Date.now();
		}
	});
}

function adminLevelForSecret(secret: string): AdminLevel | null {
	const entries: Array<[AdminLevel, string | undefined]> = [
		["operator", process.env.DEV_OPERATOR_SECRET],
		["operator", process.env.DEV_GOD_MODE_SECRET],
		["moderator", process.env.DEV_MODERATOR_SECRET],
		["observer", process.env.DEV_OBSERVER_MODE_SECRET],
	];
	for (const [level, configuredSecret] of entries) {
		if (configuredSecret && secret.endsWith(configuredSecret)) return level;
	}
	return null;
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
	if (ext === ".html" || ext === ".css" || ext === ".js") return "no-cache";
	return "public, max-age=86400";
}

async function readJson(req: import("node:http").IncomingMessage): Promise<unknown> {
	let data = "";
	for await (const chunk of req) data += chunk;
	return data ? JSON.parse(data) : {};
}

function json(res: import("node:http").ServerResponse, payload: unknown, status = 200) {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(payload));
}
