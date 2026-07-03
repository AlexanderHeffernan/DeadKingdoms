import http from "node:http";
import { readFileSync } from "node:fs";
import { TICK_MS } from "../shared/config.js";
import { Logs } from "../shared/logs.js";
import { ChangelogStore } from "./changelog.js";
import { broadcast, createHandler } from "./http.js";
import { GlobalLeaderboardStore } from "./globalLeaderboard.js";
import type { Client } from "./http.js";
import { ServerState } from "./serverState.js";
import { addNotice, configureSimulationServices, recordServerPerfPhase, stepWorld } from "./world.js";
import { ZombieAiWorkerClient } from "./zombieAiWorkerClient.js";
import { ZombieDirectorWorkerClient } from "./zombieDirectorWorkerClient.js";

loadEnvFile();
configureSimulationServices({
	zombieAi: new ZombieAiWorkerClient(),
	zombieDirector: new ZombieDirectorWorkerClient(),
});

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
let lowTpsSince: number | null = null;
let terminatingUnsafeWorld = false;

const LOW_TPS_THRESHOLD = 5;
const LOW_TPS_TERMINATE_MS = 10_000;

server.listen(port, "0.0.0.0", () => {
	console.log(`RTS arena running at http://127.0.0.1:${port}`);
	Logs.log(`Server started on port ${port}.`);
});

setInterval(() => {
	const world = state.currentWorld();
	if (world) {
		stepWorld(world, TICK_MS / 1000);
		void globalLeaderboard.trackWorldPeaks(world);
		if (shouldTerminateForLowTps(world)) {
			void terminateUnsafeWorld(world);
			return;
		}
		broadcast(world, clients);
	}
	const resetWorld = state.stepIdleReset(hasActivePlayers(world));
	if (resetWorld) void globalLeaderboard.publishWorldPeaks(resetWorld);
}, TICK_MS);

function shouldTerminateForLowTps(world: NonNullable<ReturnType<ServerState["currentWorld"]>>) {
	const now = Date.now();
	if (world.serverPerf.tps >= LOW_TPS_THRESHOLD) {
		lowTpsSince = null;
		return false;
	}
	lowTpsSince ??= now;
	return now - lowTpsSince >= LOW_TPS_TERMINATE_MS;
}

async function terminateUnsafeWorld(world: NonNullable<ReturnType<ServerState["currentWorld"]>>) {
	if (terminatingUnsafeWorld || state.currentWorld() !== world) return;
	terminatingUnsafeWorld = true;
	lowTpsSince = null;
	const diagnostics = worldSafetyDiagnostics(world);
	const message = "World terminated because server TPS stayed below the safety threshold. Join again to start a fresh map.";
	console.error(`World safety termination: ${JSON.stringify(diagnostics)}`);
	Logs.log(`World safety termination: TPS ${diagnostics.tps}, tick ${diagnostics.tick}, units ${diagnostics.units}, zombies ${diagnostics.zombies}.`);
	addNotice(world, message);
	broadcast(world, clients);
	try {
		await globalLeaderboard.publishWorldPeaks(state.restartNow("safety monitor"));
		await globalLeaderboard.flush();
	} catch (error) {
		console.error(`Could not save leaderboard data after safety termination: ${(error as Error).message}`);
	} finally {
		for (const client of clients) client.res.end();
		clients.clear();
		terminatingUnsafeWorld = false;
	}
}

function worldSafetyDiagnostics(world: NonNullable<ReturnType<ServerState["currentWorld"]>>) {
	const units = Object.values(world.units);
	return {
		tick: world.tick,
		tps: Number(world.serverPerf.tps.toFixed(2)),
		tickMs: Number(world.serverPerf.tickMs.toFixed(2)),
		players: Object.values(world.players).length,
		activePlayers: Object.values(world.players).filter((player) => !player.defeated).length,
		units: units.length,
		zombies: units.filter((unit) => unit.type === "zombie").length,
		buildings: Object.values(world.buildings).length,
		resources: Object.values(world.resources).length,
		pathRequestsThisTick: world._pathing?.pathRequestsThisTick ?? 0,
		phases: world.serverPerf.phases?.map((phase) => ({ name: phase.name, ms: Number(phase.ms.toFixed(2)) })) ?? [],
	};
}

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
