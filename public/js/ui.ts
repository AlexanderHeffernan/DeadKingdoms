import { BUILDINGS, TRAINING } from "./constants.js";
import { unitBehaviorFor } from "../../src/shared/unitRegistry.js";
import { palette } from "./sprites/palette.js";
import { sprites } from "./sprites/index.js";
import type { Building, ResourceNode, Snapshot, SpriteName, Unit } from "../../src/shared/types.js";
import type { ClientSnapshot, GameState, SelectionEntity, UIActions } from "./clientTypes.js";

const BUILD_SHORTCUTS = {
  house: "H",
  farm: "F",
  barracks: "B",
  watchTower: "T",
  lumberCamp: "L",
  foodDepot: "D",
  miningCamp: "M",
};

export class UI {
  state: GameState;
  actions: UIActions;
  resources: HTMLElement;
  status: HTMLElement;
  ping: HTMLElement;
  serverPerf: HTMLElement;
  leaderboard: HTMLElement;
  selection: HTMLElement;
  actionsEl: HTMLElement;
  toast: HTMLElement;
  lastToast: string;
  actionSignature: string;
  hoverCard: HTMLDivElement;

  constructor(state: GameState, actions: UIActions) {
    this.state = state;
    this.actions = actions;
    this.resources = mustGet("resources");
    this.status = mustGet("status");
    this.ping = mustGet("ping");
    this.serverPerf = mustGet("serverPerf");
    this.leaderboard = mustGet("leaderboard");
    this.selection = mustGet("selection");
    this.actionsEl = mustGet("actions");
    this.toast = mustGet("toast");
    this.lastToast = "";
    this.actionSignature = "";
    this.hoverCard = document.createElement("div");
    this.hoverCard.className = "action-hover hidden";
    document.body.append(this.hoverCard);
  }

  render() {
    const snapshot = this.state.snapshot;
    if (!snapshot) return;
    const player = this.state.playerId ? snapshot.players[this.state.playerId] : undefined;
    if (!player) return;
    this.resources.innerHTML = `
      ${resourcePill("wood", Math.floor(player.resources.wood))}
      ${resourcePill("food", Math.floor(player.resources.food))}
      ${resourcePill("ore", Math.floor(player.resources.ore))}
      ${populationPill(player.population, player.popCap, idleWorkerCount(snapshot, this.state.playerId ?? ""))}
    `;
    this.attachResourceHovers();
    this.status.textContent = player.defeated ? "Defeated" : "";
    this.ping.textContent = `Ping ${Math.max(0, Date.now() - snapshot.now)}ms`;
    this.serverPerf.textContent = `TPS ${Math.round(snapshot.serverPerf.tps)} Tick ${snapshot.serverPerf.tickMs.toFixed(1)}ms`;
    this.renderLeaderboard(snapshot);
    this.renderSelection(snapshot);
    const notice = snapshot.notices.at(-1)?.text || "";
    if (notice && notice !== this.lastToast) this.showToast(notice);
  }

  renderLeaderboard(snapshot: ClientSnapshot) {
    this.leaderboard.innerHTML = snapshot.leaderboard
      .map((entry) => `<li><span style="color:${entry.color}">${escapeHtml(entry.name)}</span> <strong>${entry.score}</strong> <em>${aliveTime(entry.joinedAt, snapshot.now)}</em></li>`)
      .join("");
  }

  renderSelection(snapshot: ClientSnapshot) {
    const selected = [...this.state.selectedIds]
      .map((id) => snapshot.units[id] || snapshot.buildings[id] || snapshot.resources[id])
      .filter((item): item is SelectionEntity => Boolean(item));
    if (selected.length === 0) {
      const defeated = this.state.playerId ? snapshot.players[this.state.playerId]?.defeated : undefined;
      this.selection.innerHTML = `<div class="selection-title">${defeated ? "Defeated" : "No selection"}</div><div class="selection-detail">${defeated ? "Refresh and join again to start from scratch." : "Drag-select units. Right-click to move, gather, or attack."}</div>`;
      this.renderActionSet(defeated ? [{ spriteName: "townCenter", label: "Respawn", cost: {}, action: () => this.actions.respawn() }] : []);
      return;
    }
    const first = selected[0]!;
    const owner = first.ownerId ? snapshot.players[first.ownerId] : null;
    const ownership = owner ? (owner.id === this.state.playerId! ? "Owned by you" : `Owned by ${escapeHtml(owner.name)}`) : "Neutral";
    const names = selected.reduce<Record<string, number>>((counts, entity) => {
      counts[entity.type] = (counts[entity.type] || 0) + 1;
      return counts;
    }, {});
    const carried = isUnit(first) && first.carried ? ` · carrying ${Math.floor(first.carried.amount)} ${first.carried.resource}` : "";
    const resource = first.kind === "resource" ? ` · ${Math.floor(first.amount)}/${first.maxAmount} ${first.resource} left` : "";
    const farm = isBuilding(first) && first.gatherResource()
      ? ` · ${Math.floor(first.amount || 0)}/${first.maxAmount || 0} food left${first.exhausted ? " · exhausted" : ""}`
      : "";
    this.selection.innerHTML = `
      <div class="selection-title">${Object.entries(names).map(([type, count]) => `${label(type)} x${count}`).join(", ")}</div>
      <div class="selection-detail">${ownership}${"hp" in first ? ` · ${Math.round(first.hp)}/${first.maxHp} hp` : ""}${carried}${resource}${farm}</div>
    `;
    this.renderActions(selected);
  }

  renderActions(selected: SelectionEntity[]) {
    const actions = [];
    const ownedUnits = selected.filter((entity): entity is Unit => entity.kind === "unit" && entity.ownerId === this.state.playerId);
    const ownedAnyBuildings = selected.filter((entity): entity is Building => entity.kind === "building" && entity.ownerId === this.state.playerId);
    const ownedBuildings = selected.filter((entity): entity is Building => entity.kind === "building" && entity.ownerId === this.state.playerId && isComplete(entity));
    const hasBuilder = ownedUnits.some((entity) => unitBehavior(entity).canBuild());
    if (hasBuilder) {
      for (const [buildingType, def] of Object.entries(BUILDINGS)) {
        actions.push({ spriteName: buildingType, label: def.label, cost: def.cost, shortcut: BUILD_SHORTCUTS[buildingType as keyof typeof BUILD_SHORTCUTS], action: () => this.actions.setBuildMode(buildingType) });
      }
    }
    for (const building of ownedBuildings) {
      if (building.gatherResource()) {
        const player = this.state.snapshot!.players[this.state.playerId!];
        if (!player) continue;
        actions.push({ spriteName: building.type, label: player.autoReplenishFarms ? "Auto reseed: on" : "Auto reseed: off", cost: {}, displayCost: { wood: 45 }, shortcut: "A", action: () => this.actions.toggleAutoFarm() });
        actions.push({ spriteName: building.type, label: "Reseed farm", cost: { wood: 45 }, shortcut: "R", action: () => this.actions.replenishFarm(building.id), forceDisabled: !building.exhausted && (building.amount ?? 0) > 0 });
      }
      if (building.queue?.length) {
        const first = building.queue[0];
        if (first) actions.push({ queue: true, label: `Training ${building.queue.length}/10`, detail: `${Math.max(0, Math.round(first.remaining))}s` });
      }
      const training = TRAINING[building.type as keyof typeof TRAINING];
      if (training) {
        for (const train of training) {
          actions.push({ spriteName: train.unitType, label: train.label, cost: train.cost, shortcut: train.shortcut, action: () => this.actions.train(building.id, train.unitType), forceDisabled: (building.queue?.length ?? 0) >= 10 });
        }
      }
      if (training?.length) {
        actions.push({ spriteName: training[0]?.unitType, label: "Set rally point", cost: {}, shortcut: "Y", action: () => this.actions.setRallyMode(building.id) });
      }
    }
    for (const building of ownedAnyBuildings) {
      actions.push({ spriteName: "ruin", label: `Delete ${label(building.type)}`, cost: {}, shortcut: "Del", action: () => this.actions.deleteBuilding(building.id) });
    }
    this.renderActionSet(actions);
  }

  renderActionSet(actions: ActionDef[]) {
    const player = this.state.snapshot?.players[this.state.playerId || ""];
    if (!player) return;
    const signature = JSON.stringify(actions.map((action) => ({
      queue: action.queue,
      spriteName: action.spriteName,
      label: action.label,
      detail: action.detail,
      cost: action.displayCost || action.cost,
      shortcut: action.shortcut,
      disabled: action.forceDisabled || !canAfford(player.resources, action.cost || {}),
    })));
    if (signature === this.actionSignature) return;
    this.actionSignature = signature;
    this.actionsEl.innerHTML = "";
    this.hideHover();
    for (const action of actions) {
      if (action.queue) this.addQueue(action.label, action.detail ?? "");
      else this.addButton(action.spriteName ?? "", action.label, action.cost ?? {}, action.action ?? (() => {}), action.forceDisabled, action.displayCost, action.shortcut ?? "");
    }
  }

  addQueue(label: string, detail: string) {
    const queue = document.createElement("div");
    queue.className = "queue";
    queue.innerHTML = `<strong>${escapeHtml(label)}</strong><span>${escapeHtml(detail)}</span>`;
    this.actionsEl.append(queue);
  }

  addButton(spriteName: string, label: string, cost: Record<string, number> = {}, onPointerDown: () => void, forceDisabled = false, displayCost: Record<string, number> | null = null, shortcut = "") {
    const player = this.state.snapshot?.players[this.state.playerId || ""];
    if (!player) return;
    const disabled = forceDisabled || !canAfford(player.resources, cost);
    const button = document.createElement("button");
    button.className = "action";
    button.disabled = disabled;
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.dataset.label = label;
    button.dataset.cost = formatCost(displayCost || cost);
    button.dataset.shortcut = shortcut || "";
    button.dataset.disabledReason = disabled ? disabledReason(player.resources, cost, forceDisabled) : "";
    button.append(icon(spriteName));
    button.addEventListener("pointerdown", (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!button.disabled) onPointerDown();
    });
    button.addEventListener("mouseenter", () => this.showHover(button));
    button.addEventListener("mousemove", () => this.showHover(button));
    button.addEventListener("mouseleave", () => this.hideHover());
    this.actionsEl.append(button);
  }

  showHover(button: HTMLElement) {
    if (button.dataset.hoverTitle) {
      this.showInfoHover(button);
      return;
    }
    const cost = button.dataset.cost || "free";
    const disabled = button.dataset.disabledReason;
    this.hoverCard.innerHTML = `
      <div class="hover-title">${escapeHtml(button.dataset.label ?? "")}</div>
      <div class="hover-line">Cost: ${escapeHtml(cost)}</div>
      ${button.dataset.shortcut ? `<div class="hover-line">Shortcut: ${escapeHtml(button.dataset.shortcut ?? "")}</div>` : ""}
      ${disabled ? `<div class="hover-warning">${escapeHtml(disabled ?? "")}</div>` : ""}
    `;
    const rect = button.getBoundingClientRect();
    this.hoverCard.classList.remove("hidden");
    this.hoverCard.style.left = `${Math.round(rect.left)}px`;
    this.hoverCard.style.top = `${Math.round(rect.top - this.hoverCard.offsetHeight - 10)}px`;
  }

  hideHover() {
    this.hoverCard.classList.add("hidden");
  }

  attachResourceHovers() {
    for (const pill of Array.from(this.resources.querySelectorAll<HTMLElement>(".resource-pill"))) {
      pill.addEventListener("mouseenter", () => this.showInfoHover(pill));
      pill.addEventListener("mousemove", () => this.showInfoHover(pill));
      pill.addEventListener("mouseleave", () => this.hideHover());
    }
  }

  showInfoHover(target: HTMLElement) {
    this.hoverCard.innerHTML = `
      <div class="hover-title">${escapeHtml(target.dataset.hoverTitle || "")}</div>
      <div class="hover-line">${escapeHtml(target.dataset.hoverDetail || "")}</div>
    `;
    const rect = target.getBoundingClientRect();
    this.hoverCard.classList.remove("hidden");
    this.hoverCard.style.left = `${Math.round(rect.left)}px`;
    this.hoverCard.style.top = `${Math.round(rect.bottom + 8)}px`;
  }

  showToast(text: string) {
    this.lastToast = text;
    this.toast.textContent = text;
    this.toast.classList.add("visible");
    window.setTimeout(() => this.toast.classList.remove("visible"), 2400);
  }
}

function label(type: string) {
  return type.replace(/[A-Z]/g, (char) => ` ${char}`).replace(/^./, (char) => char.toUpperCase());
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char] ?? char);
}

function isUnit(entity: SelectionEntity): entity is Unit {
  return entity.kind === "unit";
}

function isBuilding(entity: SelectionEntity): entity is Building {
  return entity.kind === "building";
}

function canAfford(resources: Record<string, number>, cost: Record<string, number>) {
  return Object.entries(cost).every(([resource, amount]) => (resources[resource] || 0) >= amount);
}

function isComplete(entity: Building) {
  return !entity.maxHp || entity.hp >= entity.maxHp;
}

function idleWorkerCount(snapshot: ClientSnapshot, playerId: string) {
  return Object.values(snapshot.units).filter((unit) => unit.ownerId === playerId && unitBehavior(unit).canGather() && (!unit.command || unit.command.type === "idle")).length;
}

function formatCost(cost: Record<string, number>) {
  const text = Object.entries(cost).map(([resource, amount]) => `${amount} ${resource}`).join(", ");
  return text || "free";
}

function disabledReason(resources: Record<string, number>, cost: Record<string, number>, forceDisabled: boolean) {
  if (forceDisabled) return "Unavailable right now";
  const missing = Object.entries(cost).filter(([resource, amount]) => (resources[resource] || 0) < amount);
  if (!missing.length) return "";
  return `Need ${missing.map(([resource, amount]) => `${amount - Math.floor(resources[resource] || 0)} more ${resource}`).join(", ")}`;
}

function icon(spriteName: string) {
  const canvas = document.createElement("canvas");
  canvas.className = "action-icon";
  canvas.width = 56;
  canvas.height = 56;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  const rows = sprites[spriteName as SpriteName] || sprites.house;
  const scale = Math.max(1, Math.floor(52 / Math.max(rows.length, rows[0]!.length)));
  const ox = Math.floor((56 - rows[0]!.length * scale) / 2);
  const oy = Math.floor((56 - rows.length * scale) / 2);
  for (let y = 0; y < rows.length; y += 1) {
    for (let x = 0; x < rows[y]!.length; x += 1) {
      const key = rows[y]![x];
      const color = key === "p" ? "#4f8fd8" : key === "P" ? "#7eb2ee" : palette[key as keyof typeof palette];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale);
    }
  }
  return canvas;
}

function resourcePill(resource: string, amount: number) {
  return `<span class="resource-pill" data-hover-title="${resourceLabel(resource)}" data-hover-detail="${resourceDescription(resource)}">${resourceIcon(resource)}<strong>${amount}</strong></span>`;
}

function populationPill(population: number, popCap: number, idleWorkers: number) {
  return `<span class="resource-pill" data-hover-title="Population" data-hover-detail="${population}/${popCap} used. ${idleWorkers} worker${idleWorkers === 1 ? "" : "s"} not currently working. Press . to cycle idle workers one at a time.">${populationIcon()}<strong>${population}/${popCap}</strong></span>`;
}

function resourceLabel(resource: string) {
  return resource.replace(/^./, (char) => char.toUpperCase());
}

function resourceDescription(resource: string) {
  const descriptions = {
    wood: "Used to construct buildings, farms, and reseed exhausted farms.",
    food: "Used to train units. Gather from berries, farms, and food depots.",
    ore: "Used for military buildings, towers, and units.",
  };
  return descriptions[resource as keyof typeof descriptions] || "Stored resource.";
}

function unitBehavior(unit: Unit) {
  return unitBehaviorFor(unit.type);
}

function aliveTime(joinedAt: number, now: number) {
  const totalMinutes = Math.max(0, Math.floor(((now || Date.now()) - (joinedAt || now || Date.now())) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function populationIcon() {
  return `<span class="resource-icon" aria-hidden="true">
    <i style="left:9px;top:3px;background:#e0a46a"></i><i style="left:12px;top:3px;background:#e0a46a"></i>
    <i style="left:9px;top:6px;background:#b2824f"></i><i style="left:12px;top:6px;background:#b2824f"></i>
    <i style="left:6px;top:12px;background:#4f8fd8"></i><i style="left:9px;top:12px;background:#4f8fd8"></i><i style="left:12px;top:12px;background:#4f8fd8"></i><i style="left:15px;top:12px;background:#4f8fd8"></i>
    <i style="left:6px;top:15px;background:#2f5d9a"></i><i style="left:9px;top:15px;background:#2f5d9a"></i><i style="left:12px;top:15px;background:#2f5d9a"></i><i style="left:15px;top:15px;background:#2f5d9a"></i>
    <i style="left:9px;top:18px;background:#252321"></i><i style="left:15px;top:18px;background:#252321"></i>
  </span>`;
}

function resourceIcon(resource: string) {
  const grids = {
    wood: [
      "........",
      ".bbWWW..",
      "bBWWWWb.",
      ".bbWWW..",
      "...bbWWW",
      "..bBWWWW",
      "...bbWWW",
      "........",
    ],
    food: [
      "........",
      "...MM...",
      "..MFFM..",
      ".MFRRFM.",
      ".FRRRRF.",
      "..FRRF..",
      "...ff...",
      "........",
    ],
    ore: [
      "........",
      "...QQ...",
      "..QMMQ..",
      ".QMMMMQ.",
      "..QMMQ..",
      ".QQ..QQ.",
      "QMMQQMMQ",
      "........",
    ],
  };
  const colors = {
    ".": "transparent",
    W: "#6a4a32",
    b: "#8b623e",
    B: "#b2824f",
    R: "#9f262f",
    F: "#d84b3e",
    f: "#f0a28a",
    L: "#6fa04a",
    l: "#5a7f38",
    Q: "#c1b77b",
    M: "#9aa3a0",
  };
  const grid = grids[resource as keyof typeof grids] || grids.wood;
  const pixels = grid.flatMap((row: string, y: number) =>
    [...row].map((key: string, x: number) => `<i style="left:${x * 3}px;top:${y * 3}px;background:${colors[key as keyof typeof colors]}"></i>`),
  ).join("");
  return `<span class="resource-icon" aria-hidden="true">${pixels}</span>`;
}

type ActionDef = {
  queue?: boolean;
  spriteName?: string;
  label: string;
  detail?: string;
  cost?: Record<string, number>;
  displayCost?: Record<string, number>;
  shortcut?: string;
  action?: () => void;
  forceDisabled?: boolean;
};

function mustGet(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element ${id}`);
  return el;
}
