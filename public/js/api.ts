import type { CommandPayload, CommandResult, PlayerId } from "../../src/shared/types.js";

export async function join(name: string, color: string) {
  return post("/api/join", { name, color });
}

export async function sendCommand(payload: CommandPayload): Promise<CommandResult> {
  return post("/api/command", payload as unknown as Record<string, unknown>) as Promise<CommandResult>;
}

export async function leave(playerId: PlayerId) {
  return post("/api/leave", { playerId });
}

export async function enableGodMode(playerId: PlayerId, secret: string) {
  return post("/api/dev/god-mode", { playerId, secret });
}

async function post(url: string, payload: Record<string, unknown>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}
