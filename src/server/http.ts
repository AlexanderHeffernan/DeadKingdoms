import { createReadStream, promises as fs } from "node:fs";
import { extname, join, normalize } from "node:path";
import { makeSnapshot } from "../shared/messages.js";
import { MAX_PLAYERS } from "../shared/config.js";
import { addPlayer, command, removePlayer, spawnZombieHorde } from "./world.js";
import type { CommandPayload, PlayerId, World } from "../shared/types.js";

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
};

// If a client's outgoing buffer exceeds this many bytes we skip sending it
// the next snapshot to avoid runaway memory and "seconds-behind" lag.
const BACKPRESSURE_BYTES = 256 * 1024;

export type Client = { playerId: PlayerId | null; res: import("node:http").ServerResponse; sentExplored: Set<number> | null };

export function createHandler(world: World, clients: Set<Client>) {
  return async function handler(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
    const host = req.headers.host || "localhost";
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (req.method === "POST" && url.pathname === "/api/join") return joinGame(req, res, world);
    if (req.method === "POST" && url.pathname === "/api/dev/god-mode") return enableGodMode(req, res, world);
    if (req.method === "POST" && url.pathname === "/api/dev/sound-debug") return enableSoundDebug(req, res, world);
    if (req.method === "POST" && url.pathname === "/api/dev/spawn-zombies") return spawnDevZombies(req, res, world);
    if (req.method === "POST" && url.pathname === "/api/command") return receiveCommand(req, res, world);
    if (req.method === "POST" && url.pathname === "/api/leave") return leaveGame(req, res, world);
    if (req.method === "GET" && url.pathname === "/events") return streamEvents(req, res, world, clients, url);
    if (req.method === "GET" && url.pathname === "/api/status") return serverStatus(res, world);
    if (req.method === "GET" && url.pathname === "/api/snapshot") return json(res, makeSnapshot(world));
    if (req.method === "GET" && url.pathname === "/api/soundtrack") return listSoundtrack(res);
    if (req.method === "GET" && url.pathname.startsWith("/assets/soundtrack/")) return serveSoundtrack(req, res, url);
    return serveStatic(req, res, url);
  };
}

async function serverStatus(res: import("node:http").ServerResponse, world: World) {
  const activePlayers = Object.values(world.players).filter((player) => !player.defeated).length;
  json(res, {
    activePlayers,
    maxPlayers: MAX_PLAYERS,
    lastUpdate: await lastUpdateTime(),
  });
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
  json(res, { ok: true, playerId });
}

async function enableGodMode(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
  const secret = process.env.DEV_GOD_MODE_SECRET;
  if (!secret) return json(res, { ok: false, error: "God mode secret is not configured." }, 403);
  const body = (await readJson(req)) as { playerId?: unknown; secret?: unknown };
  if (typeof body.playerId !== "string" || typeof body.secret !== "string" || !body.secret.endsWith(secret)) {
    return json(res, { ok: false, error: "Invalid god mode secret." }, 403);
  }
  const player = world.players[body.playerId];
  if (!player) return json(res, { ok: false, error: "Player not found." }, 404);
  player.godMode = true;
  delete player._visCache;
  json(res, { ok: true });
}

async function enableSoundDebug(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
  const secret = process.env.DEV_SOUND_DEBUG_SECRET || "revealsound";
  const body = (await readJson(req)) as { playerId?: unknown; secret?: unknown };
  if (typeof body.playerId !== "string" || typeof body.secret !== "string" || !body.secret.endsWith(secret)) {
    return json(res, { ok: false, error: "Invalid sound debug secret." }, 403);
  }
  const player = world.players[body.playerId];
  if (!player) return json(res, { ok: false, error: "Player not found." }, 404);
  player.soundDebug = true;
  json(res, { ok: true });
}

async function spawnDevZombies(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, world: World) {
  const body = (await readJson(req)) as { playerId?: unknown; count?: unknown };
  if (typeof body.playerId !== "string") return json(res, { ok: false, error: "Player not found." }, 404);
  const player = world.players[body.playerId];
  if (!player) return json(res, { ok: false, error: "Player not found." }, 404);
  if (!player.godMode) return json(res, { ok: false, error: "God mode is required." }, 403);
  const count = typeof body.count === "number" ? body.count : 500;
  const spawned = spawnZombieHorde(world, body.playerId, count);
  json(res, { ok: true, spawned });
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
  req.on("close", () => clients.delete(client));
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
