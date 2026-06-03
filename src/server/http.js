import { createReadStream, promises as fs } from "node:fs";
import { extname, join, normalize } from "node:path";
import { makeSnapshot } from "../shared/messages.js";
import { MAX_PLAYERS } from "../shared/config.js";
import { addPlayer, command, removePlayer } from "./world.js";

const PUBLIC_DIR = new URL("../../public/", import.meta.url);
const SOUNDTRACK_DIR = new URL("../../assets/soundtrack/", import.meta.url);
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

export function createHandler(world, clients) {
  return async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "POST" && url.pathname === "/api/join") return joinGame(req, res, world);
    if (req.method === "POST" && url.pathname === "/api/command") return receiveCommand(req, res, world);
    if (req.method === "POST" && url.pathname === "/api/leave") return leaveGame(req, res, world);
    if (req.method === "GET" && url.pathname === "/events") return streamEvents(req, res, world, clients, url);
    if (req.method === "GET" && url.pathname === "/api/snapshot") return json(res, makeSnapshot(world));
    if (req.method === "GET" && url.pathname === "/api/soundtrack") return listSoundtrack(res);
    if (req.method === "GET" && url.pathname.startsWith("/assets/soundtrack/")) return serveSoundtrack(req, res, url);
    return serveStatic(req, res, url);
  };
}

async function listSoundtrack(res) {
  try {
    const files = (await fs.readdir(SOUNDTRACK_DIR)).filter((file) => file.toLowerCase().endsWith(".mp3"));
    json(res, { tracks: files.map((file) => `/assets/soundtrack/${encodeURIComponent(file)}`) });
  } catch {
    json(res, { tracks: [] });
  }
}

async function serveSoundtrack(req, res, url) {
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
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

export function broadcast(world, clients) {
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

async function joinGame(req, res, world) {
  const active = Object.values(world.players).filter((player) => !player.defeated).length;
  if (active >= MAX_PLAYERS) return json(res, { ok: false, error: "Server is full." }, 403);
  const body = await readJson(req);
  const playerId = addPlayer(world, String(body.name || "Player"), body.color);
  json(res, { ok: true, playerId });
}

async function receiveCommand(req, res, world) {
  const body = await readJson(req);
  const result = command(world, body.playerId, body);
  json(res, result, result.ok ? 200 : 400);
}

async function leaveGame(req, res, world) {
  const body = await readJson(req);
  removePlayer(world, body.playerId);
  json(res, { ok: true });
}

function streamEvents(req, res, world, clients, url) {
  const playerId = url.searchParams.get("playerId");
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // sentExplored is null for the first snapshot (server then sends the full
  // explored set). After that we populate the Set so subsequent snapshots
  // only carry the new tiles in `exploredDelta`.
  const client = { playerId, res, sentExplored: null };
  clients.add(client);
  res.write(`data: ${JSON.stringify(makeSnapshot(world, playerId, null))}\n\n`);
  client.sentExplored = new Set(world.players[playerId]?.explored || []);
  req.on("close", () => clients.delete(client));
}

async function serveStatic(req, res, url) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR.pathname, safePath);
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error("Not a file");
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function readJson(req) {
  let data = "";
  for await (const chunk of req) data += chunk;
  return data ? JSON.parse(data) : {};
}

function json(res, payload, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}
