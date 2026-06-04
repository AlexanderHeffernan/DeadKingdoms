import http from "node:http";
import { TICK_MS } from "../shared/config.js";
import { broadcast, createHandler } from "./http.js";
import type { Client } from "./http.js";
import { createWorld, stepWorld } from "./world.js";

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
