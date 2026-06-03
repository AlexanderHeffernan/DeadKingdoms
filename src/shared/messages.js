export function makeSnapshot(world, playerId = null) {
  const visible = playerId ? visibleTiles(world, playerId) : null;
  const filterVisible = (entities) =>
    Object.fromEntries(
      Object.entries(entities).filter(([, entity]) => !visible || isVisible(visible, entity.x, entity.y, entity.size || 1)),
    );
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
    visibility: visible ? {
      visible: [...visible.visible],
      explored: [...visible.explored],
    } : null,
    leaderboard: world.leaderboard,
    notices: world.notices.slice(-8),
  };
}

function visibleTiles(world, playerId) {
  const player = world.players[playerId];
  const explored = player?.explored || new Set();
  const visible = new Set();
  if (!player) return { visible, explored };
  const sources = [
    ...Object.values(world.units).filter((unit) => unit.ownerId === playerId),
    ...Object.values(world.buildings).filter((building) => building.ownerId === playerId),
  ];
  for (const source of sources) {
    const radius = source.vision || 5;
    const cx = Math.round(source.x + (source.size || 0) / 2);
    const cy = Math.round(source.y + (source.size || 0) / 2);
    for (let y = cy - radius; y <= cy + radius; y += 1) {
      for (let x = cx - radius; x <= cx + radius; x += 1) {
        if (x < 0 || y < 0 || x >= world.map.size || y >= world.map.size) continue;
        if (Math.hypot(x - cx, y - cy) <= radius) {
          const key = `${x},${y}`;
          visible.add(key);
          explored.add(key);
        }
      }
    }
  }
  player.explored = explored;
  return { visible, explored };
}

function isVisible(visible, x, y, size) {
  for (let yy = Math.floor(y); yy < Math.ceil(y + size); yy += 1) {
    for (let xx = Math.floor(x); xx < Math.ceil(x + size); xx += 1) {
      if (visible.visible.has(`${xx},${yy}`)) return true;
    }
  }
  return false;
}
