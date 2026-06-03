export function makeSnapshot(world, playerId = null, sentExplored = null) {
  const visible = playerId ? cachedVisibility(world, playerId) : null;
  const visibleSet = visible ? visible.visible : null;
  const filterVisible = (entities) => {
    if (!visibleSet) return entities;
    const out = {};
    for (const id in entities) {
      const entity = entities[id];
      if (isVisible(visibleSet, entity.x, entity.y, entity.size || 1, world.map.size)) out[id] = entity;
    }
    return out;
  };

  let exploredDelta = null;
  let exploredFull = null;
  if (visible) {
    if (sentExplored) {
      exploredDelta = [];
      for (const key of visible.explored) {
        if (!sentExplored.has(key)) {
          sentExplored.add(key);
          exploredDelta.push(key);
        }
      }
    } else {
      exploredFull = [...visible.explored];
    }
  }

  return {
    type: "snapshot",
    now: Date.now(),
    playerId,
    map: world.map,
    players: Object.fromEntries(
      Object.entries(world.players).map(([id, player]) => [
        id,
        {
          id,
          name: player.name,
          color: player.color,
          resources: player.resources,
          autoReplenishFarms: player.autoReplenishFarms,
          population: player.population,
          popCap: player.popCap,
          defeated: player.defeated,
          score: player.score,
        },
      ]),
    ),
    units: filterVisible(world.units),
    buildings: filterVisible(world.buildings),
    resources: filterVisible(world.resources),
    ruins: filterVisible(world.ruins),
    visibility: visible
      ? {
          visible: [...visible.visible],
          // full explored sent only on the first snapshot per client; subsequent
          // snapshots send only the new tile keys discovered since last send.
          explored: exploredFull,
          exploredDelta,
        }
      : null,
    leaderboard: world.leaderboard,
    notices: world.notices.slice(-8),
  };
}

function cachedVisibility(world, playerId) {
  const player = world.players[playerId];
  if (!player) return null;
  if (player._visCache && player._visCache.tick === world.tick) return player._visCache;
  const computed = visibleTiles(world, playerId);
  computed.tick = world.tick;
  player._visCache = computed;
  return computed;
}

function visibleTiles(world, playerId) {
  const player = world.players[playerId];
  const explored = player?.explored || new Set();
  const visible = new Set();
  if (!player) return { visible, explored };
  const size = world.map.size;
  const addCircle = (cx, cy, radius) => {
    const r2 = radius * radius;
    const minX = Math.max(0, cx - radius);
    const maxX = Math.min(size - 1, cx + radius);
    const minY = Math.max(0, cy - radius);
    const maxY = Math.min(size - 1, cy + radius);
    for (let y = minY; y <= maxY; y += 1) {
      const dy = y - cy;
      for (let x = minX; x <= maxX; x += 1) {
        const dx = x - cx;
        if (dx * dx + dy * dy > r2) continue;
        const key = y * size + x;
        visible.add(key);
        explored.add(key);
      }
    }
  };
  for (const unit of Object.values(world.units)) {
    if (unit.ownerId !== playerId) continue;
    const radius = unit.vision || 5;
    addCircle(Math.round(unit.x), Math.round(unit.y), radius);
  }
  for (const building of Object.values(world.buildings)) {
    if (building.ownerId !== playerId) continue;
    const radius = building.vision || 5;
    const cx = Math.round(building.x + (building.size || 0) / 2);
    const cy = Math.round(building.y + (building.size || 0) / 2);
    addCircle(cx, cy, radius);
  }
  player.explored = explored;
  return { visible, explored };
}

function isVisible(visibleSet, x, y, size, mapSize) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.ceil(x + size);
  const y1 = Math.ceil(y + size);
  for (let yy = y0; yy < y1; yy += 1) {
    for (let xx = x0; xx < x1; xx += 1) {
      if (visibleSet.has(yy * mapSize + xx)) return true;
    }
  }
  return false;
}
