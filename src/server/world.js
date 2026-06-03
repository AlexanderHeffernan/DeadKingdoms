import { BUILDING_DEFS, COLORS, FARM_FOOD, FARM_REPLENISH_COST, MAP_SIZE, RESOURCE_DEFS, STARTING_RESOURCES, UNIT_DEFS } from "../shared/config.js";
import { id } from "./id.js";
import { clamp, distance, moveToward, rectsOverlap } from "./math.js";

const SPAWNS = [
  { x: 8, y: 8 },
  { x: 82, y: 9 },
  { x: 9, y: 82 },
  { x: 82, y: 82 },
  { x: 45, y: 9 },
  { x: 9, y: 45 },
  { x: 83, y: 45 },
  { x: 45, y: 83 },
  { x: 24, y: 25 },
  { x: 68, y: 68 },
];

const TREE_STUMP_THRESHOLD = 36;
const STUMP_DECAY_SECONDS = 60;

export function createWorld() {
  const world = {
    map: { size: MAP_SIZE },
    players: {},
    units: {},
    buildings: {},
    resources: {},
    ruins: {},
    notices: [],
    leaderboard: [],
    tick: 0,
  };
  seedResources(world);
  return world;
}

export function addPlayer(world, name) {
  const activeCount = Object.values(world.players).filter((p) => !p.defeated).length;
  const playerId = id("p");
  const spawn = chooseSpawn(world, activeCount);
  const color = COLORS[activeCount % COLORS.length];
  world.players[playerId] = {
    id: playerId,
    name: name.slice(0, 18) || "Player",
    color,
    resources: { ...STARTING_RESOURCES },
    autoReplenishFarms: true,
    explored: new Set(),
    population: 0,
    popCap: 0,
    defeated: false,
    score: 0,
  };

  clearSpawnTrees(world, spawn.x, spawn.y, 7);
  createBuilding(world, playerId, "townCenter", spawn.x, spawn.y, true);
  createBuilding(world, playerId, "house", spawn.x + 3, spawn.y + 1, true);
  createUnit(world, playerId, "villager", spawn.x + 1.5, spawn.y + 2.4);
  createUnit(world, playerId, "villager", spawn.x + 2.2, spawn.y + 2.8);
  createUnit(world, playerId, "soldier", spawn.x + 0.8, spawn.y + 3.1);
  addLocalResources(world, spawn.x, spawn.y);
  notice(world, `${world.players[playerId].name} joined the world.`);
  recalcPlayer(world, playerId);
  return playerId;
}

function clearSpawnTrees(world, x, y, radius) {
  for (const resource of Object.values(world.resources)) {
    if ((resource.stage === "tree" || resource.type === "tree") && distance(resource, { x, y }) <= radius) {
      delete world.resources[resource.id];
    }
  }
}

export function removePlayer(world, playerId) {
  const player = world.players[playerId];
  if (!player) return;
  notice(world, `${player.name} left the world.`);
  delete world.players[playerId];
  for (const unit of Object.values(world.units)) {
    if (unit.ownerId === playerId) delete world.units[unit.id];
  }
  for (const building of Object.values(world.buildings)) {
    if (building.ownerId === playerId) {
      createRuin(world, building);
      delete world.buildings[building.id];
    }
  }
  updateLeaderboard(world);
}

export function command(world, playerId, body) {
  const player = world.players[playerId];
  if (!player || player.defeated) return { ok: false, error: "Player unavailable." };
  if (body.type === "move") return commandMove(world, playerId, body);
  if (body.type === "build") return commandBuild(world, playerId, body);
  if (body.type === "train") return commandTrain(world, playerId, body);
  if (body.type === "attack") return commandAttack(world, playerId, body);
  if (body.type === "gather") return commandGather(world, playerId, body);
  if (body.type === "toggleAutoFarm") return commandToggleAutoFarm(world, playerId);
  if (body.type === "replenishFarm") return commandReplenishFarm(world, playerId, body);
  return { ok: false, error: "Unknown command." };
}

export function stepWorld(world, dt) {
  world.tick += 1;
  stepResourceDecay(world, dt);
  for (const unit of Object.values(world.units)) stepUnit(world, unit, dt);
  for (const building of Object.values(world.buildings)) stepBuilding(world, building, dt);
  for (const playerId of Object.keys(world.players)) recalcPlayer(world, playerId);
  updateLeaderboard(world);
}

function seedResources(world) {
  for (let grove = 0; grove < 44; grove += 1) {
    const cx = 4 + Math.floor(Math.random() * (MAP_SIZE - 8));
    const cy = 4 + Math.floor(Math.random() * (MAP_SIZE - 8));
    const count = 12 + Math.floor(Math.random() * 18);
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * 6;
      createResource(world, "tree", cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
    }
  }
  for (let vein = 0; vein < 15; vein += 1) {
    const cx = 5 + Math.floor(Math.random() * (MAP_SIZE - 10));
    const cy = 5 + Math.floor(Math.random() * (MAP_SIZE - 10));
    for (let i = 0; i < 5 + Math.floor(Math.random() * 4); i += 1) {
      createResource(world, "ore", cx + Math.floor(Math.random() * 5) - 2, cy + Math.floor(Math.random() * 5) - 2);
    }
  }
}

function addLocalResources(world, x, y) {
  const spots = [
    ["tree", x - 3, y + 1],
    ["tree", x - 4, y + 2],
    ["tree", x + 4, y + 2],
    ["tree", x + 5, y + 3],
    ["tree", x + 5, y + 4],
    ["tree", x + 6, y + 3],
    ["ore", x + 2, y + 5],
    ["ore", x + 3, y + 5],
  ];
  for (const [type, rx, ry] of spots) createResource(world, type, rx, ry);
}

function chooseSpawn(world, count) {
  let best = SPAWNS[count % SPAWNS.length];
  let bestDistance = -1;
  for (const spawn of SPAWNS) {
    const nearest = Object.values(world.buildings)
      .filter((b) => b.type === "townCenter")
      .reduce((min, building) => Math.min(min, distance(spawn, building)), Infinity);
    if (nearest > bestDistance) {
      best = spawn;
      bestDistance = nearest;
    }
  }
  return best;
}

function createUnit(world, ownerId, type, x, y) {
  const def = UNIT_DEFS[type];
  const unit = {
    id: id("u"),
    kind: "unit",
    ownerId,
    type,
    x,
    y,
    hp: def.maxHp,
    maxHp: def.maxHp,
    command: { type: "idle" },
    cooldown: 0,
    attackFlash: 0,
    workFlash: 0,
    facing: "right",
    carried: null,
    selected: false,
  };
  world.units[unit.id] = unit;
  return unit;
}

function createBuilding(world, ownerId, type, x, y, free = false) {
  const def = BUILDING_DEFS[type];
  const building = {
    id: id("b"),
    kind: "building",
    ownerId,
    type,
    x: Math.round(x),
    y: Math.round(y),
    size: def.size,
    hp: def.maxHp,
    maxHp: def.maxHp,
    queue: [],
    cooldown: 0,
    attackFlash: 0,
    vision: def.vision || 5,
  };
  if (type === "farm") {
    building.amount = def.farmFood || FARM_FOOD;
    building.maxAmount = def.farmFood || FARM_FOOD;
    building.resource = "food";
    building.exhausted = false;
  }
  if (!free && !spend(world.players[ownerId], def.cost)) return null;
  world.buildings[building.id] = building;
  return building;
}

function createResource(world, type, x, y) {
  x = clamp(Math.round(x), 1, MAP_SIZE - 2);
  y = clamp(Math.round(y), 1, MAP_SIZE - 2);
  const blocked = [...Object.values(world.resources), ...Object.values(world.buildings)].some((entity) =>
    Math.round(entity.x) === x && Math.round(entity.y) === y,
  );
  if (blocked) return null;
  const def = RESOURCE_DEFS[type];
  const resource = {
    id: id("r"),
    kind: "resource",
    type,
    x,
    y,
    amount: def.amount,
    maxAmount: def.amount,
    resource: def.resource,
    stage: type === "tree" ? "tree" : type,
    decay: 0,
  };
  world.resources[resource.id] = resource;
  return resource;
}

function createRuin(world, building) {
  const ruinId = id("x");
  world.ruins[ruinId] = {
    id: ruinId,
    kind: "ruin",
    type: building.type,
    x: building.x,
    y: building.y,
    size: building.size,
    age: 0,
  };
}

function commandMove(world, playerId, body) {
  forOwnUnits(world, playerId, body.unitIds, (unit, index) => {
    const target = {
      x: clamp(Number(body.x) + (index % 3) * 0.25, 0, MAP_SIZE - 1),
      y: clamp(Number(body.y) + Math.floor(index / 3) * 0.25, 0, MAP_SIZE - 1),
    };
    unit.command = {
      type: "move",
      ...target,
      path: findPath(world, unit, target),
    };
  });
  return { ok: true };
}

function commandAttack(world, playerId, body) {
  const target = world.units[body.targetId] || world.buildings[body.targetId];
  if (!target || target.ownerId === playerId) return { ok: false, error: "Invalid target." };
  forOwnUnits(world, playerId, body.unitIds, (unit) => {
    unit.command = { type: "attack", targetId: target.id, path: null };
  });
  return { ok: true };
}

function commandGather(world, playerId, body) {
  const resource = world.resources[body.targetId] || farmAsResource(world.buildings[body.targetId]);
  if (!resource) return { ok: false, error: "Invalid resource." };
  if (resource.type === "farm" && resource.ownerId !== playerId) return { ok: false, error: "You can only work your own farms." };
  forOwnUnits(world, playerId, body.unitIds, (unit) => {
    if (UNIT_DEFS[unit.type].canGather) unit.command = { type: "gather", targetId: resource.id, progress: 0, path: null };
  });
  return { ok: true };
}

function commandToggleAutoFarm(world, playerId) {
  const player = world.players[playerId];
  player.autoReplenishFarms = !player.autoReplenishFarms;
  return { ok: true, autoReplenishFarms: player.autoReplenishFarms };
}

function commandReplenishFarm(world, playerId, body) {
  const farm = world.buildings[body.farmId];
  if (!farm || farm.ownerId !== playerId || farm.type !== "farm") return { ok: false, error: "Select one of your farms." };
  return replenishFarm(world, farm) ? { ok: true } : { ok: false, error: "Not enough wood to reseed farm." };
}

function commandBuild(world, playerId, body) {
  const def = BUILDING_DEFS[body.buildingType];
  if (!def) return { ok: false, error: "Unknown building." };
  const x = clamp(Math.round(Number(body.x)), 0, MAP_SIZE - def.size);
  const y = clamp(Math.round(Number(body.y)), 0, MAP_SIZE - def.size);
  if (!canPlace(world, x, y, def.size)) return { ok: false, error: "Blocked tile." };
  const builders = Object.values(world.units).filter(
    (unit) => unit.ownerId === playerId && body.unitIds?.includes(unit.id) && UNIT_DEFS[unit.type].canBuild,
  );
  if (builders.length === 0) return { ok: false, error: "Select a villager to build." };
  const building = createBuilding(world, playerId, body.buildingType, x, y);
  if (!building) return { ok: false, error: "Not enough resources." };
  building.hp = Math.max(12, Math.floor(building.maxHp * 0.25));
  for (const unit of builders) unit.command = { type: "build", targetId: building.id, path: null };
  return { ok: true };
}

function commandTrain(world, playerId, body) {
  const building = world.buildings[body.buildingId];
  const unitDef = UNIT_DEFS[body.unitType];
  const buildingDef = building && BUILDING_DEFS[building.type];
  if (!building || building.ownerId !== playerId || !unitDef || !buildingDef?.trains?.includes(body.unitType)) {
    return { ok: false, error: "Cannot train there." };
  }
  const player = world.players[playerId];
  if (player.population >= player.popCap) return { ok: false, error: "Population cap reached." };
  if (building.queue.length >= 10) return { ok: false, error: "Training queue is full." };
  if (!spend(player, unitDef.cost)) return { ok: false, error: "Not enough resources." };
  building.queue.push({ unitType: body.unitType, remaining: unitDef.trainTime });
  return { ok: true };
}

function forOwnUnits(world, playerId, unitIds, fn) {
  if (!Array.isArray(unitIds)) return;
  unitIds.forEach((unitId, index) => {
    const unit = world.units[unitId];
    if (unit?.ownerId === playerId) fn(unit, index);
  });
}

function stepUnit(world, unit, dt) {
  unit.cooldown = Math.max(0, unit.cooldown - dt);
  unit.attackFlash = Math.max(0, (unit.attackFlash || 0) - dt);
  unit.workFlash = Math.max(0, (unit.workFlash || 0) - dt);
  unit.vision = UNIT_DEFS[unit.type].vision || 5;
  const command = unit.command || { type: "idle" };
  if (command.type === "move") {
    unit.facing = command.x < unit.x ? "left" : "right";
    if (moveWithPath(world, unit, command, UNIT_DEFS[unit.type].speed * dt)) unit.command = { type: "idle" };
  } else if (command.type === "attack") {
    stepAttack(world, unit, command, dt);
  } else if (command.type === "gather") {
    stepGather(world, unit, command, dt);
  } else if (command.type === "build") {
    stepBuild(world, unit, command, dt);
  } else {
    autoAcquire(world, unit);
  }
}

function stepBuilding(world, building, dt) {
  const def = BUILDING_DEFS[building.type];
  building.cooldown = Math.max(0, building.cooldown - dt);
  building.attackFlash = Math.max(0, (building.attackFlash || 0) - dt);
  if (building.queue.length > 0) {
    building.queue[0].remaining -= dt;
    if (building.queue[0].remaining <= 0) {
      const item = building.queue.shift();
      createUnit(world, building.ownerId, item.unitType, building.x + building.size + 0.4, building.y + building.size + 0.2);
    }
  }
  if (def.attack) {
    const target = nearestEnemy(world, building, def.range);
    if (target && building.cooldown <= 0) {
      damage(world, target, def.attack, building.ownerId);
      building.cooldown = def.cooldown;
      building.attackFlash = 0.22;
    }
  }
}

function stepAttack(world, unit, command, dt) {
  const target = world.units[command.targetId] || world.buildings[command.targetId];
  if (!target || target.ownerId === unit.ownerId) {
    const nextTarget = nearestEnemy(world, unit, 5.5);
    unit.command = nextTarget ? { type: "attack", targetId: nextTarget.id } : { type: "idle" };
    return;
  }
  const def = UNIT_DEFS[unit.type];
  const range = def.range + (target.size || 0.6);
  if (distance(unit, centerOf(target)) > range) {
    unit.facing = centerOf(target).x < unit.x ? "left" : "right";
    moveNearTarget(world, unit, command, centerOf(target), range, def.speed * dt);
    return;
  }
  if (unit.cooldown <= 0) {
    damage(world, target, def.attack, unit.ownerId);
    unit.cooldown = def.cooldown;
    unit.attackFlash = 0.22;
    const nextTarget = nearestEnemy(world, unit, 5.5);
    if (nextTarget && !world.units[command.targetId] && !world.buildings[command.targetId]) {
      unit.command = { type: "attack", targetId: nextTarget.id };
    }
  }
}

function stepGather(world, unit, command, dt) {
  let resource = world.resources[command.targetId] || farmAsResource(world.buildings[command.targetId]);
  if (unit.carried?.amount > 0) {
    const depot = nearestDepot(world, unit.ownerId, unit.carried.resource, unit);
    if (!depot) return;
    if (distance(unit, centerOf(depot)) > depot.size + 0.7) {
      moveNearTarget(world, unit, command, centerOf(depot), depot.size + 0.7, UNIT_DEFS[unit.type].speed * dt);
      return;
    }
    world.players[unit.ownerId].resources[unit.carried.resource] += unit.carried.amount;
    unit.carried = null;
    return;
  }
  if (!resource || resource.amount <= 0 || !UNIT_DEFS[unit.type].canGather) {
    if (resource?.kind === "building" && resource.type === "farm") maybeAutoReplenishFarm(world, resource);
    unit.command = { type: "idle" };
    return;
  }
  if (distance(unit, resource) > 1.1) {
    moveNearTarget(world, unit, command, resource, 1.1, UNIT_DEFS[unit.type].speed * dt);
    return;
  }
  unit.workFlash = 0.25;
  command.progress = (command.progress || 0) + dt;
  if (command.progress >= 1.1) {
    const amount = Math.min(UNIT_DEFS[unit.type].carryCapacity || 24, resource.amount);
    resource.amount -= amount;
    unit.carried = { resource: resource.resource, amount };
    command.progress = 0;
    if (resource.kind === "building" && resource.type === "farm") {
      resource.exhausted = resource.amount <= 0;
      maybeAutoReplenishFarm(world, resource);
    } else if (resource.amount <= 0) {
      delete world.resources[resource.id];
    } else if (resource.type === "tree" && resource.amount <= TREE_STUMP_THRESHOLD) {
      makeStump(resource);
    }
  }
}

function stepResourceDecay(world, dt) {
  for (const resource of Object.values(world.resources)) {
    if (resource.stage !== "stump") continue;
    resource.decay = (resource.decay || 0) + dt;
    if (resource.decay >= STUMP_DECAY_SECONDS) delete world.resources[resource.id];
  }
}

function makeStump(resource) {
  if (resource.stage === "stump") return;
  resource.stage = "stump";
  resource.type = "stump";
  resource.sprite = "stump";
  resource.decay = 0;
}

function stepBuild(world, unit, command, dt) {
  const building = world.buildings[command.targetId];
  if (!building || building.ownerId !== unit.ownerId) {
    unit.command = { type: "idle" };
    return;
  }
  if (distance(unit, centerOf(building)) > building.size + 0.7) {
    moveNearTarget(world, unit, command, centerOf(building), building.size + 0.7, UNIT_DEFS[unit.type].speed * dt);
    return;
  }
  unit.workFlash = 0.2;
  building.hp = Math.min(building.maxHp, building.hp + 38 * dt);
  if (building.hp >= building.maxHp) unit.command = { type: "idle" };
}

function autoAcquire(world, unit) {
  if (unit.type !== "soldier") return;
  const target = nearestEnemy(world, unit, 5.5);
  if (target) unit.command = { type: "attack", targetId: target.id };
}

function nearestDepot(world, ownerId, resource, source) {
  let best = null;
  let bestDist = Infinity;
  for (const building of Object.values(world.buildings)) {
    const def = BUILDING_DEFS[building.type];
    if (building.ownerId !== ownerId || !def.accepts?.includes(resource)) continue;
    const d = distance(source, centerOf(building));
    if (d < bestDist) {
      best = building;
      bestDist = d;
    }
  }
  return best;
}

function farmAsResource(building) {
  if (!building || building.type !== "farm") return null;
  return building;
}

function maybeAutoReplenishFarm(world, farm) {
  const player = world.players[farm.ownerId];
  if (!player?.autoReplenishFarms || farm.amount > 0) return;
  replenishFarm(world, farm);
}

function replenishFarm(world, farm) {
  const player = world.players[farm.ownerId];
  if (!player || !spend(player, FARM_REPLENISH_COST)) return false;
  farm.amount = farm.maxAmount || FARM_FOOD;
  farm.exhausted = false;
  return true;
}

function nearestEnemy(world, source, range) {
  let best = null;
  let bestDist = range;
  for (const entity of [...Object.values(world.units), ...Object.values(world.buildings)]) {
    if (entity.ownerId === source.ownerId || entity.hp <= 0) continue;
    const d = distance(centerOf(source), centerOf(entity));
    if (d < bestDist) {
      best = entity;
      bestDist = d;
    }
  }
  return best;
}

function damage(world, target, amount, attackerId) {
  target.hp -= amount;
  if (target.hp > 0) return;
  if (target.kind === "building") {
    createRuin(world, target);
    delete world.buildings[target.id];
    if (target.type === "townCenter") defeatPlayer(world, target.ownerId, attackerId);
  } else {
    delete world.units[target.id];
  }
}

function defeatPlayer(world, playerId, attackerId) {
  const player = world.players[playerId];
  if (!player || player.defeated) return;
  player.defeated = true;
  const attacker = world.players[attackerId];
  notice(world, `${player.name}'s town center was destroyed${attacker ? ` by ${attacker.name}` : ""}.`);
}

function canPlace(world, x, y, size) {
  const rect = { x, y, size };
  if (x < 0 || y < 0 || x + size >= MAP_SIZE || y + size >= MAP_SIZE) return false;
  for (const building of Object.values(world.buildings)) {
    if (rectsOverlap(rect, building)) return false;
  }
  for (const resource of Object.values(world.resources)) {
    if (resource.x >= x && resource.x < x + size && resource.y >= y && resource.y < y + size) return false;
  }
  return true;
}

function moveUnit(world, unit, target, maxStep) {
  const before = { x: unit.x, y: unit.y };
  const arrived = moveToward(unit, target, maxStep);
  if (isUnitBlocked(world, unit, target)) {
    unit.x = before.x;
    unit.y = before.y;
    return true;
  }
  return arrived;
}

function moveWithPath(world, unit, command, maxStep) {
  if (!command.path || command.path.length === 0) {
    command.path = findPath(world, unit, command);
  }
  const waypoint = command.path?.[0] || command;
  unit.facing = waypoint.x < unit.x ? "left" : "right";
  const arrivedWaypoint = moveUnit(world, unit, waypoint, maxStep);
  if (arrivedWaypoint && command.path?.length) command.path.shift();
  return (!command.path || command.path.length === 0) && distance(unit, command) < 0.35;
}

function moveNearTarget(world, unit, command, target, range, maxStep) {
  if (distance(unit, target) <= range) return true;
  if (!command.path || command.path.length === 0 || world.tick % 12 === 0) {
    command.path = findPath(world, unit, nearestWalkableAround(world, target));
  }
  const waypoint = command.path?.[0] || target;
  unit.facing = waypoint.x < unit.x ? "left" : "right";
  const arrivedWaypoint = moveUnit(world, unit, waypoint, maxStep);
  if (arrivedWaypoint && command.path?.length) command.path.shift();
  return false;
}

function isUnitBlocked(world, unit, target) {
  const tileX = Math.floor(unit.x);
  const tileY = Math.floor(unit.y);
  for (const resource of Object.values(world.resources)) {
    if (Math.floor(resource.x) === tileX && Math.floor(resource.y) === tileY && distance(unit, target) > 1.6) return true;
  }
  for (const building of Object.values(world.buildings)) {
    if (unit.x >= building.x && unit.x < building.x + building.size && unit.y >= building.y && unit.y < building.y + building.size) {
      if (distance(unit, target) <= building.size + 0.8) return false;
      return true;
    }
  }
  return false;
}

function findPath(world, unit, target) {
  const start = { x: Math.floor(unit.x), y: Math.floor(unit.y) };
  const goal = nearestWalkableAround(world, target);
  if (!isInMap(goal.x, goal.y)) return [];
  if (start.x === goal.x && start.y === goal.y) return [{ x: goal.x + 0.5, y: goal.y + 0.5 }];
  const open = [{ ...start, g: 0, f: heuristic(start, goal), parent: null }];
  const best = new Map([[key(start), open[0]]]);
  const closed = new Set();
  const dirs = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
    { x: 1, y: 1 },
    { x: 1, y: -1 },
    { x: -1, y: 1 },
    { x: -1, y: -1 },
  ];
  let iterations = 0;
  while (open.length && iterations < 900) {
    iterations += 1;
    open.sort((a, b) => a.f - b.f);
    const current = open.shift();
    if (current.x === goal.x && current.y === goal.y) return unpackPath(current);
    closed.add(key(current));
    for (const dir of dirs) {
      const next = { x: current.x + dir.x, y: current.y + dir.y };
      if (!isInMap(next.x, next.y) || closed.has(key(next))) continue;
      if (!isWalkable(world, next.x, next.y, unit) && !(next.x === goal.x && next.y === goal.y)) continue;
      if (dir.x !== 0 && dir.y !== 0 && (!isWalkable(world, current.x + dir.x, current.y, unit) || !isWalkable(world, current.x, current.y + dir.y, unit))) continue;
      const cost = current.g + (dir.x !== 0 && dir.y !== 0 ? 1.4 : 1);
      const existing = best.get(key(next));
      if (existing && existing.g <= cost) continue;
      const node = { ...next, g: cost, f: cost + heuristic(next, goal), parent: current };
      best.set(key(next), node);
      open.push(node);
    }
  }
  return [];
}

function nearestWalkableAround(world, target) {
  const origin = { x: Math.floor(target.x), y: Math.floor(target.y) };
  if (isWalkable(world, origin.x, origin.y)) return origin;
  let best = origin;
  let bestDistance = Infinity;
  for (let radius = 1; radius <= 6; radius += 1) {
    for (let y = origin.y - radius; y <= origin.y + radius; y += 1) {
      for (let x = origin.x - radius; x <= origin.x + radius; x += 1) {
        if (Math.abs(x - origin.x) !== radius && Math.abs(y - origin.y) !== radius) continue;
        if (!isWalkable(world, x, y)) continue;
        const d = Math.hypot(x - target.x, y - target.y);
        if (d < bestDistance) {
          best = { x, y };
          bestDistance = d;
        }
      }
    }
    if (bestDistance < Infinity) return best;
  }
  return best;
}

function isWalkable(world, x, y, unit = null) {
  if (!isInMap(x, y)) return false;
  for (const resource of Object.values(world.resources)) {
    if (Math.floor(resource.x) === x && Math.floor(resource.y) === y) return false;
  }
  for (const building of Object.values(world.buildings)) {
    if (x >= building.x && x < building.x + building.size && y >= building.y && y < building.y + building.size) return false;
  }
  return true;
}

function isInMap(x, y) {
  return x >= 0 && y >= 0 && x < MAP_SIZE && y < MAP_SIZE;
}

function key(point) {
  return `${point.x},${point.y}`;
}

function heuristic(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function unpackPath(node) {
  const path = [];
  let current = node;
  while (current?.parent) {
    path.push({ x: current.x + 0.5, y: current.y + 0.5 });
    current = current.parent;
  }
  path.reverse();
  return path;
}

function centerOf(entity) {
  const offset = entity.size ? entity.size / 2 : 0;
  return { x: entity.x + offset, y: entity.y + offset };
}

function spend(player, cost = {}) {
  for (const [resource, amount] of Object.entries(cost)) {
    if ((player.resources[resource] || 0) < amount) return false;
  }
  for (const [resource, amount] of Object.entries(cost)) player.resources[resource] -= amount;
  return true;
}

function recalcPlayer(world, playerId) {
  const player = world.players[playerId];
  if (!player) return;
  const units = Object.values(world.units).filter((unit) => unit.ownerId === playerId);
  const buildings = Object.values(world.buildings).filter((building) => building.ownerId === playerId);
  player.population = units.length;
  player.popCap = 4 + buildings.reduce((sum, building) => sum + (BUILDING_DEFS[building.type].pop || 0), 0);
  const unitScore = units.reduce((sum, unit) => sum + UNIT_DEFS[unit.type].score, 0);
  const buildingScore = buildings.reduce((sum, building) => sum + BUILDING_DEFS[building.type].score, 0);
  const resourceScore = Math.floor(Object.values(player.resources).reduce((sum, amount) => sum + amount, 0) / 8);
  player.score = player.defeated ? 0 : unitScore + buildingScore + resourceScore;
}

function updateLeaderboard(world) {
  world.leaderboard = Object.values(world.players)
    .map((player) => ({ id: player.id, name: player.name, color: player.color, score: player.score, defeated: player.defeated }))
    .sort((a, b) => b.score - a.score);
}

function notice(world, text) {
  world.notices.push({ id: id("n"), text, at: Date.now() });
}
