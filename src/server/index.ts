import http from "node:http";
import { readFileSync } from "node:fs";
import { TICK_MS } from "../shared/config.js";
import { broadcast, createHandler } from "./http.js";
import type { Client } from "./http.js";
import { createWorld, stepWorld } from "./world.js";

loadEnvFile();

const port = Number(process.env.PORT || 3000);
const world = createWorld();
const clients = new Set<Client>();
const server = http.createServer(createHandler(world, clients));

server.listen(port, "0.0.0.0", () => {
	console.log(`RTS arena running at http://127.0.0.1:${port}`);
});

setInterval(() => {
	stepWorld(world, TICK_MS / 1000);
	broadcast(world, clients);
}, TICK_MS);

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
