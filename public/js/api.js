export async function join(name) {
  return post("/api/join", { name });
}

export async function sendCommand(payload) {
  return post("/api/command", payload);
}

export async function leave(playerId) {
  return post("/api/leave", { playerId });
}

async function post(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}
