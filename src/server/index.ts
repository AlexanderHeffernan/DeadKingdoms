import http from "node:http";
import { readFileSync } from "node:fs";
import { TICK_MS } from "../shared/config.js";
import { Logs } from "../shared/logs.js";
import { ChangelogStore } from "./changelog.js";
import { broadcast, createHandler } from "./http.js";
import { GlobalLeaderboardStore } from "./globalLeaderboard.js";
import type { Client } from "./http.js";
import { ServerState } from "./serverState.js";
import { recordServerPerfPhase, stepWorld } from "./world.js";

loadEnvFile();

const port = Number(process.env.PORT || 3000);
const state = new ServerState();
const globalLeaderboard = new GlobalLeaderboardStore();
const changelog = new ChangelogStore(new URL("../../public/changelog.json", import.meta.url));
globalLeaderboard.setPerfSink((name, label, ms) => {
	const world = state.currentWorld();
	if (world) recordServerPerfPhase(world, name, label, ms);
});
Logs.setSource("server");
Logs.setSink((entry) => state.recordLog(entry.source, entry.message, entry.at));
const clients = new Set<Client>();
await changelog.load();
const server = http.createServer(createHandler(state, clients, globalLeaderboard, changelog));
let shuttingDown = false;

server.listen(port, "0.0.0.0", () => {
	console.log(`RTS arena running at http://127.0.0.1:${port}`);
	Logs.log(`Server started on port ${port}.`);
});

setInterval(() => {
	const world = state.currentWorld();
	if (world) {
		stepWorld(world, TICK_MS / 1000);
		void globalLeaderboard.trackWorldPeaks(world);
		broadcast(world, clients);
	}
	const resetWorld = state.stepIdleReset(hasActivePlayers(world));
	if (resetWorld) void globalLeaderboard.publishWorldPeaks(resetWorld);
}, TICK_MS);

async function shutdown(signal: NodeJS.Signals) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`Received ${signal}; saving leaderboard data before shutdown.`);
	const world = state.currentWorld();
	try {
		await globalLeaderboard.publishWorldPeaks(world);
		await globalLeaderboard.flush();
	} catch (error) {
		console.error(`Could not save leaderboard data during shutdown: ${(error as Error).message}`);
	}
	for (const client of clients) client.res.end();
	clients.clear();
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

function hasActivePlayers(world: ReturnType<ServerState["currentWorld"]>) {
	return !!world && Object.values(world.players).some((player) => !player.defeated);
}

function loadEnvFile() {
	try {
		const text = readFileSync(new URL("../../.env", import.meta.url), "utf8");
		for (const rawLine of text.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			const index = line.indexOf("=");
			if (index <= 0) continue;
			const key = line.slice(0, index).trim();
			const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
			process.env[key] ??= value;
		}
	} catch {
		// .env is optional; production can provide real environment variables.
	}
}
