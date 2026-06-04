import { COLORS, MAP_SIZE, RESOURCE_DEFS, STARTING_RESOURCES, STARTING_UNITS } from "../shared/config.js";
import { BUILDING_DEFS, createBuildingEntity } from "../shared/buildingRegistry.js";
import { unitBehaviorFor } from "../shared/unitRegistry.js";
import type { GatherTarget } from "../shared/buildingDefinitions.js";
import { id } from "./id.js";
import { clamp, distance, moveToward, rectsOverlap } from "./math.js";
import type {
  BuildQueueItem,
  Building,
  BuildingId,
  BuildingType,
  CommandPayload,
  CommandResult,
  EntityId,
  PathNode,
  Player,
  PlayerId,
  ResourceNode,
  ResourceType,
  Ruin,
  Unit,
  UnitCommand,
  UnitId,
  UnitType,
  World,
} from "../shared/types.js";

const SPAWNS = [
  { x: 8, y: 8 },
  { x: 178, y: 9 },
  { x: 9, y: 178 },
  { x: 178, y: 178 },
  { x: 95, y: 9 },
  { x: 9, y: 95 },
  { x: 179, y: 95 },
  { x: 95, y: 179 },
  { x: 48, y: 50 },
  { x: 140, y: 140 },
];

const TREE_STUMP_THRESHOLD = 36;
const STUMP_DECAY_SECONDS = 60;
const RUIN_DECAY_SECONDS = 60;

export function createWorld(): World {
  const world: World = {
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
  rebuildOccupancy(world);
  return world;
}

export function addPlayer(world: World, name: string, requestedColor: string | null = null): PlayerId {
  const activeCount = Object.values(world.players).filter((p) => !p.defeated).length;
  const playerId = id("p");
  const spawn = chooseSpawn(world, activeCount);
  const color: string = normalizeColor(requestedColor) || COLORS[activeCount % COLORS.length]!;
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
    joinedAt: Date.now(),
  };

  clearSpawnResources(world, spawn.x, spawn.y, 14);
  createBuilding(world, playerId, "townCenter", spawn.x, spawn.y, true);
  for (const unit of STARTING_UNITS) createUnit(world, playerId, unit.unitType, spawn.x + unit.x, spawn.y + unit.y);
  addLocalResources(world, spawn.x, spawn.y);
  notice(world, `${world.players[playerId]!.name} joined the world.`);
  recalcPlayer(world, playerId);
  updateLeaderboard(world);
  return playerId;
}

function clearSpawnResources(world: World, x: number, y: number, radius: number) {
  for (const resource of Object.values(world.resources)) {
    if (distance(resource, { x, y }) <= radius) {
      delete world.resources[resource.id];
    }
  }
}

export function removePlayer(world: World, playerId: PlayerId) {
  const player = world.players[playerId];
  if (!player) return;
  notice(world, `${player.name} left the world.`);
  destroyPlayerStuff(world, playerId);
  delete world.players[playerId];
  updateLeaderboard(world);
}

export function command(world: World, playerId: PlayerId, body: CommandPayload): CommandResult {
  const player = world.players[playerId];
  if (!player || player.defeated) return { ok: false, error: "Player unavailable." };
  rebuildOccupancy(world);
  const handler = COMMAND_HANDLERS[body.type];
  if (!handler) return { ok: false, error: "Unknown command." };
  return handler(world, playerId, body as never);
}

export function stepWorld(world: World, dt: number) {
  world.tick += 1;
  rebuildOccupancy(world);
  stepResourceDecay(world, dt);
  stepRuinDecay(world, dt);
  for (const unit of Object.values(world.units)) stepUnit(world, unit, dt);
  resolveUnitSeparation(world);
  for (const building of Object.values(world.buildings)) stepBuilding(world, building, dt);
  for (const playerId of Object.keys(world.players)) recalcPlayer(world, playerId);
  updateLeaderboard(world);
}

type CommandHandler<T extends CommandPayload["type"]> = (
  world: World,
  playerId: PlayerId,
  body: Extract<CommandPayload, { type: T }>,
) => CommandResult;

const COMMAND_HANDLERS: { [K in CommandPayload["type"]]: CommandHandler<K> } = {
  move: commandMove,
  build: commandBuild,
  finishBuild: commandFinishBuild,
  deleteBuilding: commandDeleteBuilding,
  setRallyPoint: commandSetRallyPoint,
  train: commandTrain,
  attack: commandAttack,
  gather: commandGather,
  toggleAutoFarm: commandToggleAutoFarm,
  replenishFarm: commandReplenishFarm,
};

type UnitCommandHandler<T extends UnitCommand["type"]> = (
  world: World,
  unit: Unit,
  command: Extract<UnitCommand, { type: T }>,
  dt: number,
) => void;

const UNIT_COMMANDS: { [K in UnitCommand["type"]]: UnitCommandHandler<K> } = {
  idle: (world, unit) => autoAcquire(world, unit),
  move: (world, unit, command, dt) => {
    unit.facing = command.x < unit.x ? "left" : "right";
    if (moveWithPath(world, unit, command, unitBehavior(unit).stats.speed * dt)) unit.command = { type: "idle" };
  },
  attack: stepAttack,
  gather: stepGather,
  build: stepBuild,
};

function rebuildOccupancy(world: World) {
  const size = MAP_SIZE;
  if (!world._occupancy || world._occupancy.length !== size * size) {
    world._occupancy = new Uint8Array(size * size);
  } else {
    world._occupancy.fill(0);
  }
  const grid = world._occupancy;
  for (const resource of Object.values(world.resources)) {
    const x = Math.floor(resource.x);
    const y = Math.floor(resource.y);
    if (x >= 0 && y >= 0 && x < size && y < size) grid[y * size + x] = 1;
  }
  for (const building of Object.values(world.buildings)) {
    if (!building.isWalkBlocking()) continue;
    for (let dy = 0; dy < building.size; dy += 1) {
      for (let dx = 0; dx < building.size; dx += 1) {
        const x = building.x + dx;
        const y = building.y + dy;
        if (x >= 0 && y >= 0 && x < size && y < size) grid[y * size + x] = 1;
      }
    }
  }
}

function occupied(world: World, x: number, y: number): boolean {
  if (!world._occupancy) return false;
  if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE) return true;
  return world._occupancy[y * MAP_SIZE + x] === 1;
}

function seedResources(world: World) {
  for (let grove = 0; grove < 176; grove += 1) {
    const cx = 4 + Math.floor(Math.random() * (MAP_SIZE - 8));
    const cy = 4 + Math.floor(Math.random() * (MAP_SIZE - 8));
    const count = 12 + Math.floor(Math.random() * 18);
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * 6;
      createResource(world, "tree", cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
    }
  }
  for (let vein = 0; vein < 60; vein += 1) {
    const cx = 5 + Math.floor(Math.random() * (MAP_SIZE - 10));
    const cy = 5 + Math.floor(Math.random() * (MAP_SIZE - 10));
    for (let i = 0; i < 5 + Math.floor(Math.random() * 4); i += 1) {
      createResource(world, "ore", cx + Math.floor(Math.random() * 5) - 2, cy + Math.floor(Math.random() * 5) - 2);
    }
  }
  for (let patch = 0; patch < 88; patch += 1) {
    const cx = 5 + Math.floor(Math.random() * (MAP_SIZE - 10));
    const cy = 5 + Math.floor(Math.random() * (MAP_SIZE - 10));
    for (let i = 0; i < 4 + Math.floor(Math.random() * 4); i += 1) {
      createResource(world, "berry", cx + Math.floor(Math.random() * 4) - 2, cy + Math.floor(Math.random() * 4) - 2);
    }
  }
}

function addLocalResources(world: World, x: number, y: number) {
  const sx = x < MAP_SIZE / 2 ? 1 : -1;
  const sy = y < MAP_SIZE / 2 ? 1 : -1;
  const spots = [
    ["tree", x + sx * 15, y + sy * 1] as const,
    ["tree", x + sx * 16, y + sy * 2] as const,
    ["tree", x + sx * 15, y + sy * 3] as const,
    ["tree", x + sx * 17, y + sy * 3] as const,
    ["tree", x + sx * 16, y + sy * 4] as const,
    ["tree", x + sx * 18, y + sy * 4] as const,
    ["berry", x + sx * 11, y + sy * 11] as const,
    ["berry", x + sx * 12, y + sy * 12] as const,
    ["berry", x + sx * 10, y + sy * 12] as const,
    ["ore", x + sx * 4, y + sy * 15] as const,
    ["ore", x + sx * 5, y + sy * 16] as const,
  ];
  for (const [type, rx, ry] of spots) createResource(world, type as "tree" | "ore" | "berry", rx, ry);
}

function chooseSpawn(world: World, count: number) {
  let best = SPAWNS[count % SPAWNS.length]!;
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

function createUnit(world: World, ownerId: PlayerId, type: UnitType, x: number, y: number): Unit {
  const def = unitBehaviorFor(type);
  const unit: Unit = {
    id: id("u"),
    kind: "unit",
    ownerId,
    type,
    x,
    y,
    hp: def.stats.maxHp,
    maxHp: def.stats.maxHp,
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

function createBuilding(world: World, ownerId: PlayerId, type: BuildingType, x: number, y: number, free = false): Building | null {
  const def = BUILDING_DEFS[type];
  const building = createBuildingEntity(type, { id: id("b"), ownerId, x, y });
  if (!free && !spend(world.players[ownerId]!, def.stats.cost)) return null;
  world.buildings[building.id] = building;
  return building;
}

function createResource(world: World, type: keyof typeof RESOURCE_DEFS, x: number, y: number): ResourceNode | null {
  x = clamp(Math.round(x), 1, MAP_SIZE - 2);
  y = clamp(Math.round(y), 1, MAP_SIZE - 2);
  const blocked = [...Object.values(world.resources), ...Object.values(world.buildings)].some((entity) => pointInsideEntity(x, y, entity));
  if (blocked) return null;
  const def = RESOURCE_DEFS[type];
  const resource: ResourceNode = {
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

function createRuin(world: World, building: Building) {
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

function pointInsideEntity(x: number, y: number, entity: { x: number; y: number; size?: number }): boolean {
  const size = entity.size || 1;
  return x >= Math.floor(entity.x) && x < Math.floor(entity.x) + size && y >= Math.floor(entity.y) && y < Math.floor(entity.y) + size;
}

function commandMove(world: World, playerId: PlayerId, body: Extract<CommandPayload, { type: "move" }>): CommandResult {
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

function commandAttack(world: World, playerId: PlayerId, body: Extract<CommandPayload, { type: "attack" }>): CommandResult {
  const target = world.units[body.targetId] || world.buildings[body.targetId];
  if (!target || target.ownerId === playerId) return { ok: false, error: "Invalid target." };
  let assigned = false;
  forOwnUnits(world, playerId, body.unitIds, (unit) => {
    unit.command = { type: "attack", targetId: target.id, path: null };
    assigned = true;
  });
  return assigned ? { ok: true } : { ok: false, error: "Select units to command." };
}

function commandGather(world: World, playerId: PlayerId, body: Extract<CommandPayload, { type: "gather" }>): CommandResult {
  const resource = world.resources[body.targetId] || gatherableBuilding(world.buildings[body.targetId], playerId);
  if (!resource) return { ok: false, error: "Invalid resource." };
  let assigned = false;
  forOwnUnits(world, playerId, body.unitIds, (unit) => {
    if (unitBehavior(unit).canGather()) {
      unit.command = {
        type: "gather",
        targetId: resource.id,
        // Remember what this worker was after so we can auto-find another
        // tree / ore vein / farm when the current target is gone.
        resourceKind: resource.resource!,
        progress: 0,
        path: null,
      };
      assigned = true;
    }
  });
  return assigned ? { ok: true } : { ok: false, error: "Select gather-capable units." };
}

function commandToggleAutoFarm(world: World, playerId: PlayerId): CommandResult {
  const player = world.players[playerId];
  if (!player) return { ok: false, error: "Player not found." };
  player.autoReplenishFarms = !player.autoReplenishFarms;
  return { ok: true, autoReplenishFarms: player.autoReplenishFarms };
}

function commandReplenishFarm(world: World, playerId: PlayerId, body: Extract<CommandPayload, { type: "replenishFarm" }>): CommandResult {
  const farm = world.buildings[body.farmId];
  if (!farm || farm.ownerId !== playerId || !farm.canBeGatheredBy(playerId)) return { ok: false, error: "Select one of your completed farms." };
  return replenishFarm(world, farm) ? { ok: true } : { ok: false, error: "Not enough wood to reseed farm." };
}

function commandBuild(world: World, playerId: PlayerId, body: Extract<CommandPayload, { type: "build" }>): CommandResult {
  const def = BUILDING_DEFS[body.buildingType];
  if (!def) return { ok: false, error: "Unknown building." };
  const x = clamp(Math.round(Number(body.x)), 0, MAP_SIZE - def.stats.size);
  const y = clamp(Math.round(Number(body.y)), 0, MAP_SIZE - def.stats.size);
  if (!canPlace(world, x, y, def.stats.size)) return { ok: false, error: "Blocked tile." };
  const builders = Object.values(world.units).filter(
    (unit) => unit.ownerId === playerId && body.unitIds?.includes(unit.id) && unitBehavior(unit).canBuild(),
  );
  if (builders.length === 0) return { ok: false, error: "Select build-capable units." };
  const building = createBuilding(world, playerId, body.buildingType, x, y);
  if (!building) return { ok: false, error: "Not enough resources." };
  building.hp = Math.max(12, Math.floor(building.maxHp * 0.25));
  building.builderIds = builders.map((unit) => unit.id);
  const resourceKind = building.depotGatherKind();
  for (const unit of builders) unit.command = { type: "build", targetId: building.id, path: null, resourceKind, gatherBuiltFarm: building.shouldGatherAfterBuild() };
  return { ok: true };
}

function commandFinishBuild(world: World, playerId: PlayerId, body: Extract<CommandPayload, { type: "finishBuild" }>): CommandResult {
  const building = world.buildings[body.buildingId];
  if (!building || building.ownerId !== playerId) return { ok: false, error: "Invalid building." };
  if (isComplete(building)) return { ok: false, error: "Building is already complete." };
  const builders = Object.values(world.units).filter(
    (unit) => unit.ownerId === playerId && body.unitIds?.includes(unit.id) && unitBehavior(unit).canBuild(),
  );
  if (builders.length === 0) return { ok: false, error: "Select build-capable units." };
  const resourceKind = building.depotGatherKind();
  building.builderIds = [...new Set([...(building.builderIds || []), ...builders.map((unit) => unit.id)])];
  for (const unit of builders) unit.command = { type: "build", targetId: building.id, path: null, resourceKind, gatherBuiltFarm: building.shouldGatherAfterBuild() };
  return { ok: true };
}

function commandDeleteBuilding(world: World, playerId: PlayerId, body: Extract<CommandPayload, { type: "deleteBuilding" }>): CommandResult {
  const building = world.buildings[body.buildingId];
  if (!building || building.ownerId !== playerId) return { ok: false, error: "Select one of your buildings." };
  createRuin(world, building);
  delete world.buildings[building.id];
  for (const unit of Object.values(world.units)) {
    if ("targetId" in unit.command && unit.command.targetId === building.id) unit.command = { type: "idle" };
  }
  return { ok: true };
}

function commandSetRallyPoint(world: World, playerId: PlayerId, body: Extract<CommandPayload, { type: "setRallyPoint" }>): CommandResult {
  const building = world.buildings[body.buildingId];
  if (!building || building.ownerId !== playerId || building.trainableUnits().length === 0) return { ok: false, error: "Select a production building." };
  building.rallyPoint = {
    x: clamp(Number(body.x), 0, MAP_SIZE - 1),
    y: clamp(Number(body.y), 0, MAP_SIZE - 1),
  };
  return { ok: true };
}

function commandTrain(world: World, playerId: PlayerId, body: Extract<CommandPayload, { type: "train" }>): CommandResult {
  const building = world.buildings[body.buildingId];
  const unitDef = unitBehaviorFor(body.unitType);
  if (!building || building.ownerId !== playerId || !isComplete(building) || !unitDef) {
    return { ok: false, error: "Cannot train there." };
  }
  if (!building.canTrain(body.unitType)) {
    return { ok: false, error: "Cannot train there." };
  }
  const player = world.players[playerId];
  if (!player) return { ok: false, error: "Player not found." };
  if (player.population >= player.popCap) return { ok: false, error: "Population cap reached." };
  if (building.queue.length >= 10) return { ok: false, error: "Training queue is full." };
  if (!spend(player, unitDef.stats.cost)) return { ok: false, error: "Not enough resources." };
  building.queue.push({ unitType: body.unitType, remaining: unitDef.stats.trainTime } as BuildQueueItem);
  return { ok: true };
}

function forOwnUnits(world: World, playerId: PlayerId, unitIds: UnitId[] | undefined, fn: (unit: Unit, index: number) => void) {
  if (!Array.isArray(unitIds)) return;
  unitIds.forEach((unitId, index) => {
    const unit = world.units[unitId];
    if (unit?.ownerId === playerId) fn(unit, index);
  });
}

function stepUnit(world: World, unit: Unit, dt: number) {
  unit.cooldown = Math.max(0, unit.cooldown - dt);
  unit.attackFlash = Math.max(0, (unit.attackFlash || 0) - dt);
  unit.workFlash = Math.max(0, (unit.workFlash || 0) - dt);
  unit.vision = unitBehavior(unit).stats.vision || 5;
  const command = unit.command || { type: "idle" };
  const handler = UNIT_COMMANDS[command.type];
  if (handler) handler(world, unit, command as never, dt);
}

function stepBuilding(world: World, building: Building, dt: number) {
  building.cooldown = Math.max(0, building.cooldown - dt);
  building.attackFlash = Math.max(0, (building.attackFlash || 0) - dt);
  if (!isComplete(building)) return;
  if (building.queue.length > 0) {
    const current = building.queue[0];
    if (current) current.remaining -= dt;
    if (current && current.remaining <= 0) {
      const item = building.queue.shift();
      if (!item) return;
      const unit = createUnit(world, building.ownerId, item.unitType, building.x + building.size + 0.4, building.y + building.size + 0.2);
      if (building.rallyPoint) {
        unit.command = { type: "move", ...building.rallyPoint, path: findPath(world, unit, building.rallyPoint) };
      }
    }
  }
  const attack = building.attackStats();
  if (attack) {
    const target = nearestEnemy(world, building, attack.range);
    if (target && building.cooldown <= 0) {
      damage(world, target, attack.attack, building.ownerId);
      building.cooldown = attack.cooldown;
      building.attackFlash = 0.22;
    }
  }
}

function stepAttack(world: World, unit: Unit, command: Extract<UnitCommand, { type: "attack" }>, dt: number) {
  const target = world.units[command.targetId] || world.buildings[command.targetId];
  if (!target || target.ownerId === unit.ownerId) {
    const nextTarget = nearestEnemy(world, unit, 5.5);
    unit.command = nextTarget ? { type: "attack", targetId: nextTarget.id } : { type: "idle" };
    return;
  }
  const def = unitBehavior(unit);
  const range = def.stats.range + (target.size || 0.6);
  if (distance(unit, centerOf(target)) > range) {
    unit.facing = centerOf(target).x < unit.x ? "left" : "right";
    moveNearTarget(world, unit, command, centerOf(target), range, def.stats.speed * dt);
    return;
  }
  if (unit.cooldown <= 0) {
    damage(world, target, def.stats.attack, unit.ownerId);
    unit.cooldown = def.stats.cooldown;
    unit.attackFlash = 0.22;
    const nextTarget = nearestEnemy(world, unit, 5.5);
    if (nextTarget && !world.units[command.targetId] && !world.buildings[command.targetId]) {
      unit.command = { type: "attack", targetId: nextTarget.id };
    }
  }
}

function stepGather(world: World, unit: Unit, command: Extract<UnitCommand, { type: "gather" }>, dt: number) {
  let resource: ResourceNode | Building | null | undefined = world.resources[command.targetId] || gatherableBuilding(world.buildings[command.targetId], unit.ownerId);
  if (unit.carried && unit.carried.amount > 0) {
    const depot = nearestDepot(world, unit.ownerId, unit.carried.resource, unit);
    if (!depot) return;
    if (distance(unit, centerOf(depot)) > depot.size + 0.7) {
      moveNearTarget(world, unit, command, centerOf(depot), depot.size + 0.7, unitBehavior(unit).stats.speed * dt);
      return;
    }
    world.players[unit.ownerId]!.resources[unit.carried.resource] += unit.carried.amount;
    unit.carried = null;
    return;
  }
  const behavior = unitBehavior(unit);
  if (!resource || resource.amount! <= 0 || !behavior.canGather()) {
    if (isBuilding(resource)) {
      maybeAutoReplenishBuilding(world, resource);
      if (resource.amount! > 0) return;
    }
    const next = findNextResource(world, unit, command.resourceKind);
    if (next) {
      command.targetId = next.id;
      command.path = null;
      command.progress = 0;
      return;
    }
    unit.command = { type: "idle" };
    return;
  }
  const targetPoint = isBuilding(resource) ? centerOf(resource) : resource;
  const gatherRange = isBuilding(resource) ? resource.gatherRange() : 1.1;
  if (distance(unit, targetPoint) > gatherRange) {
    moveNearTarget(world, unit, command, targetPoint, gatherRange, behavior.stats.speed * dt);
    return;
  }
  unit.workFlash = 0.25;
  command.progress = (command.progress || 0) + dt;
  const gatherTarget = gatherTargetFor(resource);
  const gatherSeconds = behavior.gatherSeconds(gatherTarget);
  if (command.progress >= gatherSeconds) {
    const amount = Math.min(behavior.gatherAmount(gatherTarget), resource.amount!);
    resource.amount! -= amount;
    unit.carried = { resource: gatherResource(resource), amount };
    command.progress = 0;
    if (isBuilding(resource)) {
      resource.onGatheredOut();
      maybeAutoReplenishBuilding(world, resource);
    } else if (resource.amount! <= 0) {
      delete world.resources[resource.id];
    } else if (resource.type === "tree" && resource.amount! <= TREE_STUMP_THRESHOLD) {
      makeStump(resource as ResourceNode);
    }
  }
}

function stepResourceDecay(world: World, dt: number) {
  for (const resource of Object.values(world.resources)) {
    if (resource.stage !== "stump") continue;
    resource.decay = (resource.decay || 0) + dt;
    if (resource.decay >= STUMP_DECAY_SECONDS) delete world.resources[resource.id];
  }
}

function stepRuinDecay(world: World, dt: number) {
  for (const ruin of Object.values(world.ruins)) {
    ruin.age = (ruin.age || 0) + dt;
    if (ruin.age >= RUIN_DECAY_SECONDS) delete world.ruins[ruin.id];
  }
}

function makeStump(resource: ResourceNode) {
  if (resource.stage === "stump") return;
  resource.stage = "stump";
  resource.type = "stump";
  resource.sprite = "stump";
  resource.decay = 0;
}

function stepBuild(world: World, unit: Unit, command: Extract<UnitCommand, { type: "build" }>, dt: number) {
  const building = world.buildings[command.targetId];
  if (!building || building.ownerId !== unit.ownerId) {
    unit.command = { type: "idle" };
    return;
  }
  if (isComplete(building)) {
    assignPostBuildGather(world, unit, command.resourceKind, command.gatherBuiltFarm ? building : null);
    return;
  }
  if (distance(unit, centerOf(building)) > building.size + 0.7) {
    moveNearTarget(world, unit, command, centerOf(building), building.size + 0.7, unitBehavior(unit).stats.speed * dt);
    return;
  }
  unit.workFlash = 0.2;
  building.hp = Math.min(building.maxHp, building.hp + 38 * dt);
  if (building.hp >= building.maxHp) assignPostBuildGather(world, unit, command.resourceKind, command.gatherBuiltFarm ? building : null);
}

function assignPostBuildGather(world: World, unit: Unit, resourceKind: ResourceType | null, builtFarm: Building | null = null) {
  if (builtFarm && unitBehavior(unit).canGather() && isComplete(builtFarm)) {
    const resource = builtFarm.gatherResource();
    if (resource) {
      unit.command = { type: "gather", targetId: builtFarm.id, resourceKind: resource, progress: 0, path: null };
      return;
    }
  }
  const nextBuild = findNextBuildSite(world, unit);
  if (nextBuild) {
    nextBuild.builderIds = [...new Set([...(nextBuild.builderIds || []), unit.id])];
    unit.command = { type: "build", targetId: nextBuild.id, path: null, resourceKind: nextBuild.depotGatherKind(), gatherBuiltFarm: nextBuild.shouldGatherAfterBuild() };
    return;
  }
  if (!resourceKind || !unitBehavior(unit).canGather()) {
    unit.command = { type: "idle" };
    return;
  }
  const next = findNextResource(world, unit, resourceKind);
  unit.command = next ? { type: "gather", targetId: next.id, resourceKind, progress: 0, path: null } : { type: "idle" };
}

function findNextBuildSite(world: World, unit: Unit): Building | null {
  let bestInitiated = null;
  let bestInitiatedDist = Infinity;
  let bestNearby = null;
  let bestNearbyDist = 28;
  for (const building of Object.values(world.buildings)) {
    if (building.ownerId !== unit.ownerId || isComplete(building)) continue;
    const d = distance(unit, centerOf(building));
    if (building.builderIds?.includes(unit.id) && d < bestInitiatedDist) {
      bestInitiated = building;
      bestInitiatedDist = d;
    }
    if (d < bestNearbyDist) {
      bestNearby = building;
      bestNearbyDist = d;
    }
  }
  return bestInitiated || bestNearby;
}

function autoAcquire(world: World, unit: Unit) {
  if (!unitBehavior(unit).canAutoAcquireTargets()) return;
  const target = nearestEnemy(world, unit, 5.5);
  if (target) unit.command = { type: "attack", targetId: target.id };
}

function findNextResource(world: World, unit: Unit, resourceKind: ResourceType | null): ResourceNode | Building | null {
  if (!resourceKind) return null;
  const RANGE = 30;
  let best = null;
  let bestDist = RANGE;
  for (const r of Object.values(world.resources)) {
    if (r.amount <= 0 || r.resource !== resourceKind) continue;
    const d = distance(unit, r);
    if (d < bestDist) {
      best = r;
      bestDist = d;
    }
  }
  for (const b of Object.values(world.buildings)) {
    if (!b.canBeGatheredBy(unit.ownerId) || b.gatherResource() !== resourceKind || b.isGatherExhausted()) continue;
    const d = distance(unit, b);
    if (d < bestDist) {
      best = b;
      bestDist = d;
    }
  }
  return best;
}

function nearestDepot(world: World, ownerId: PlayerId, resource: ResourceType, source: { x: number; y: number }) {
  let best = null;
  let bestDist = Infinity;
  for (const building of Object.values(world.buildings)) {
    if (building.ownerId !== ownerId || !isComplete(building) || !building.canAcceptResource(resource)) continue;
    const d = distance(source, centerOf(building));
    if (d < bestDist) {
      best = building;
      bestDist = d;
    }
  }
  return best;
}

function gatherableBuilding(building: Building | undefined, playerId: PlayerId): Building | null {
  if (!building?.canBeGatheredBy(playerId)) return null;
  return building;
}

function maybeAutoReplenishBuilding(world: World, building: Building) {
  const player = world.players[building.ownerId];
  if (!player) return;
  building.maybeReplenish((cost) => spend(player, cost), player.autoReplenishFarms);
}

function replenishFarm(world: World, building: Building): boolean {
  const player = world.players[building.ownerId];
  if (!player) return false;
  return building.maybeReplenish((cost) => spend(player, cost), true);
}

function nearestEnemy(world: World, source: Unit | Building, range: number) {
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

function isBuilding(entity: ResourceNode | Building | null | undefined): entity is Building {
  return entity?.kind === "building";
}

function gatherResource(entity: ResourceNode | Building): ResourceType {
  if (isBuilding(entity)) return entity.gatherResource()!;
  return entity.resource;
}

function gatherTargetFor(entity: ResourceNode | Building): GatherTarget {
  if (isBuilding(entity)) return entity;
  return {
    gatherAmountFor: (unit) => unit.carryCapacity(),
    gatherSecondsFor: () => 1.1,
  };
}

function damage(world: World, target: Unit | Building, amount: number, attackerId: PlayerId) {
  target.hp -= amount;
  if (target.hp > 0) return;
  if (target.kind === "building") {
    createRuin(world, target);
    delete world.buildings[target.id];
    if (target.isTownCenter()) defeatPlayer(world, target.ownerId, attackerId);
  } else {
    delete world.units[target.id];
  }
}

function defeatPlayer(world: World, playerId: PlayerId, attackerId: PlayerId) {
  const player = world.players[playerId];
  if (!player || player.defeated) return;
  player.defeated = true;
  const attacker = world.players[attackerId];
  notice(world, `${player.name}'s town center was destroyed${attacker ? ` by ${attacker.name}` : ""}.`);
  destroyPlayerStuff(world, playerId);
}

function destroyPlayerStuff(world: World, playerId: PlayerId) {
  for (const unit of Object.values(world.units)) {
    if (unit.ownerId === playerId) delete world.units[unit.id];
  }
  for (const building of Object.values(world.buildings)) {
    if (building.ownerId === playerId) {
      createRuin(world, building);
      delete world.buildings[building.id];
    }
  }
}

function canPlace(world: World, x: number, y: number, size: number): boolean {
  if (x < 0 || y < 0 || x + size > MAP_SIZE || y + size > MAP_SIZE) return false;
  for (const building of Object.values(world.buildings)) {
    if (rectsOverlap({ x, y, size }, building)) return false;
  }
  for (let dy = 0; dy < size; dy += 1) {
    for (let dx = 0; dx < size; dx += 1) {
      if (occupied(world, x + dx, y + dy)) return false;
    }
  }
  return true;
}

function moveUnit(world: World, unit: Unit, target: { x: number; y: number }, maxStep: number): boolean {
  const before = { x: unit.x, y: unit.y };
  const arrived = moveToward(unit, target, maxStep);
  if (isUnitBlocked(world, unit, target)) {
    unit.x = before.x;
    unit.y = before.y;
    return true;
  }
  return arrived;
}

function resolveUnitSeparation(world: World) {
  const units = Object.values(world.units);
  const minDistance = 0.48;
  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      const a = units[i]!;
      const b = units[j]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist >= minDistance) continue;
      const push = (minDistance - (dist || 0.001)) / 2;
      const nx = dist ? dx / dist : 1;
      const ny = dist ? dy / dist : 0;
      nudgeUnit(world, a, -nx * push, -ny * push);
      nudgeUnit(world, b, nx * push, ny * push);
    }
  }
}

function nudgeUnit(world: World, unit: Unit, dx: number, dy: number) {
  const before = { x: unit.x, y: unit.y };
  unit.x = clamp(unit.x + dx, 0.2, MAP_SIZE - 0.2);
  unit.y = clamp(unit.y + dy, 0.2, MAP_SIZE - 0.2);
  if (occupied(world, Math.floor(unit.x), Math.floor(unit.y))) {
    unit.x = before.x;
    unit.y = before.y;
  }
}

function moveWithPath(world: World, unit: Unit, command: Extract<UnitCommand, { type: "move" }>, maxStep: number): boolean {
  if (!command.path || command.path.length === 0) {
    command.path = findPath(world, unit, command);
  }
  const waypoint = command.path?.[0] || command;
  unit.facing = waypoint.x < unit.x ? "left" : "right";
  const arrivedWaypoint = moveUnit(world, unit, waypoint, maxStep);
  if (arrivedWaypoint && command.path?.length) command.path.shift();
  return (!command.path || command.path.length === 0) && distance(unit, command) < 0.35;
}

function moveNearTarget(world: World, unit: Unit, command: UnitCommand, target: { x: number; y: number }, range: number, maxStep: number): boolean {
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

function isUnitBlocked(world: World, unit: Unit, target: { x: number; y: number }): boolean {
  const tileX = Math.floor(unit.x);
  const tileY = Math.floor(unit.y);
  if (!occupied(world, tileX, tileY)) return false;
  // Check if the occupant is a building the unit is standing on (e.g. just spawned)
  for (const building of Object.values(world.buildings)) {
    if (unit.x >= building.x && unit.x < building.x + building.size && unit.y >= building.y && unit.y < building.y + building.size) {
      if (distance(unit, target) <= building.size + 0.8) return false;
      return true;
    }
  }
  // Otherwise it's a resource tile: blocked unless we're close to our target.
  return distance(unit, target) > 1.6;
}

function findPath(world: World, unit: Unit, target: { x: number; y: number }): PathNode[] {
  const start = { x: Math.floor(unit.x), y: Math.floor(unit.y) };
  const goal = nearestWalkableAround(world, target);
  if (!isInMap(goal.x, goal.y)) return [];
  if (start.x === goal.x && start.y === goal.y) return [{ x: goal.x + 0.5, y: goal.y + 0.5 }];
  const open: PathNode[] = [{ ...start, g: 0, f: heuristic(start, goal), parent: null }];
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
    open.sort((a, b) => (a.f ?? 0) - (b.f ?? 0));
    const current = open.shift()!;
    if (current.x === goal.x && current.y === goal.y) return unpackPath(current);
    closed.add(key(current));
    for (const dir of dirs) {
      const next = { x: current.x + dir.x, y: current.y + dir.y };
      if (!isInMap(next.x, next.y) || closed.has(key(next))) continue;
      if (!isWalkable(world, next.x, next.y) && !(next.x === goal.x && next.y === goal.y)) continue;
      if (dir.x !== 0 && dir.y !== 0 && (!isWalkable(world, current.x + dir.x, current.y) || !isWalkable(world, current.x, current.y + dir.y))) continue;
      const cost = (current.g ?? 0) + (dir.x !== 0 && dir.y !== 0 ? 1.4 : 1);
      const existing = best.get(key(next));
      if (existing && (existing.g ?? 0) <= cost) continue;
      const node = { ...next, g: cost, f: cost + heuristic(next, goal), parent: current };
      best.set(key(next), node);
      open.push(node);
    }
  }
  return [];
}

function nearestWalkableAround(world: World, target: { x: number; y: number }) {
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

function isWalkable(world: World, x: number, y: number): boolean {
  if (!isInMap(x, y)) return false;
  return !occupied(world, x, y);
}

function isInMap(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < MAP_SIZE && y < MAP_SIZE;
}

function key(point: { x: number; y: number }): string {
  return `${point.x},${point.y}`;
}

function heuristic(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function unpackPath(node: PathNode): PathNode[] {
  const path = [];
  let current = node;
  while (current?.parent) {
    path.push({ x: current.x + 0.5, y: current.y + 0.5 });
    current = current.parent;
  }
  path.reverse();
  return path;
}

function centerOf(entity: { x: number; y: number; size?: number }) {
  const offset = entity.size ? (entity.size - 1) / 2 : 0;
  return { x: entity.x + offset, y: entity.y + offset };
}

function spend(player: Player, cost: Partial<Record<ResourceType, number>> = {}): boolean {
  const entries = Object.entries(cost) as [ResourceType, number][];
  for (const [resource, amount] of entries) {
    if ((player.resources[resource] || 0) < amount) return false;
  }
  for (const [resource, amount] of entries) player.resources[resource] -= amount;
  return true;
}

function recalcPlayer(world: World, playerId: PlayerId) {
  const player = world.players[playerId];
  if (!player) return;
  const units = Object.values(world.units).filter((unit) => unit.ownerId === playerId);
  const buildings = Object.values(world.buildings).filter((building) => building.ownerId === playerId);
  player.population = units.length;
  player.popCap = 4 + buildings.filter(isComplete).reduce((sum, building) => {
    return sum + building.populationCapacity();
  }, 0);
  const unitScore = units.reduce((sum, unit) => sum + unitBehavior(unit).stats.score, 0);
  const buildingScore = buildings.reduce((sum, building) => sum + BUILDING_DEFS[building.type].stats.score, 0);
  const resourceScore = Math.floor(Object.values(player.resources).reduce((sum, amount) => sum + amount, 0) / 8);
  player.score = player.defeated ? 0 : unitScore + buildingScore + resourceScore;
}

function isComplete(building: Building): boolean {
  return building.isComplete();
}

function updateLeaderboard(world: World) {
  world.leaderboard = Object.values(world.players)
    .filter((player) => !player.defeated)
    .map((player) => ({ id: player.id, name: player.name, color: player.color, score: player.score, defeated: player.defeated, joinedAt: player.joinedAt }))
    .sort((a, b) => b.score - a.score);
}

function notice(world: World, text: string) {
  world.notices.push({ id: id("n"), text, at: Date.now() });
}

function normalizeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^#[0-9a-f]{6}$/i.test(value) ? value : null;
}

function unitBehavior(unit: Unit) {
  return unitBehaviorFor(unit.type);
}
