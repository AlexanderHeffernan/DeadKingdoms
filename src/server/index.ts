import http from "node:http";
import { readFileSync } from "node:fs";
import { TICK_MS } from "../shared/config.js";
import { Logs } from "../shared/logs.js";
import { broadcast, createHandler } from "./http.js";
import type { Client } from "./http.js";
import { ServerState } from "./serverState.js";
import { stepWorld } from "./world.js";

loadEnvFile();

const port = Number(process.env.PORT || 3000);
const state = new ServerState();
Logs.setSource("server");
Logs.setSink((entry) => state.recordLog(entry.source, entry.message, entry.at));
const clients = new Set<Client>();
const server = http.createServer(createHandler(state, clients));

server.listen(port, "0.0.0.0", () => {
	console.log(`RTS arena running at http://127.0.0.1:${port}`);
	Logs.log(`Server started on port ${port}.`);
});

setInterval(() => {
	const world = state.currentWorld();
	if (world) {
		stepWorld(world, TICK_MS / 1000);
		broadcast(world, clients);
	}
	state.stepIdleReset(hasActivePlayers(world));
}, TICK_MS);

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
