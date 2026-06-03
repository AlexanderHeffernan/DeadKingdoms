import { BUILDINGS, TRAINING } from "./constants.js";
import { palette } from "./sprites/palette.js";
import { sprites } from "./sprites/index.js";

export class UI {
  constructor(state, actions) {
    this.state = state;
    this.actions = actions;
    this.resources = document.getElementById("resources");
    this.status = document.getElementById("status");
    this.leaderboard = document.getElementById("leaderboard");
    this.selection = document.getElementById("selection");
    this.actionsEl = document.getElementById("actions");
    this.toast = document.getElementById("toast");
    this.lastToast = "";
    this.actionSignature = "";
    this.hoverCard = document.createElement("div");
    this.hoverCard.className = "action-hover hidden";
    document.body.append(this.hoverCard);
  }

  render() {
    const snapshot = this.state.snapshot;
    if (!snapshot) return;
    const player = snapshot.players[this.state.playerId];
    if (!player) return;
    this.resources.innerHTML = `
      ${resourcePill("wood", Math.floor(player.resources.wood))}
      ${resourcePill("food", Math.floor(player.resources.food))}
      ${resourcePill("ore", Math.floor(player.resources.ore))}
    `;
    this.status.textContent = `Population ${player.population}/${player.popCap} · ${player.defeated ? "Defeated" : "Active"}`;
    this.renderLeaderboard(snapshot);
    this.renderSelection(snapshot);
    const notice = snapshot.notices.at(-1)?.text || "";
    if (notice && notice !== this.lastToast) this.showToast(notice);
  }

  renderLeaderboard(snapshot) {
    this.leaderboard.innerHTML = snapshot.leaderboard
      .map((entry) => `<li><span style="color:${entry.color}">${escapeHtml(entry.name)}</span> ${entry.score}</li>`)
      .join("");
  }

  renderSelection(snapshot) {
    const selected = [...this.state.selectedIds].map((id) => snapshot.units[id] || snapshot.buildings[id] || snapshot.resources[id]).filter(Boolean);
    if (selected.length === 0) {
      const defeated = snapshot.players[this.state.playerId]?.defeated;
      this.selection.innerHTML = `<div class="selection-title">${defeated ? "Defeated" : "No selection"}</div><div class="selection-detail">${defeated ? "Refresh and join again to start from scratch." : "Drag-select units. Right-click to move, gather, or attack."}</div>`;
      this.renderActionSet(defeated ? [{ spriteName: "townCenter", label: "Respawn", cost: {}, action: () => this.actions.respawn() }] : []);
      return;
    }
    const first = selected[0];
    const owner = first.ownerId ? snapshot.players[first.ownerId] : null;
    const ownership = owner ? (owner.id === this.state.playerId ? "Owned by you" : `Owned by ${escapeHtml(owner.name)}`) : "Neutral";
    const names = selected.reduce((counts, entity) => {
      counts[entity.type] = (counts[entity.type] || 0) + 1;
      return counts;
    }, {});
    const carried = first.carried ? ` · carrying ${Math.floor(first.carried.amount)} ${first.carried.resource}` : "";
    const resource = first.kind === "resource" ? ` · ${Math.floor(first.amount)}/${first.maxAmount} ${first.resource} left` : "";
    const farm = first.type === "farm" ? ` · ${Math.floor(first.amount || 0)}/${first.maxAmount || 0} food left${first.exhausted ? " · exhausted" : ""}` : "";
    this.selection.innerHTML = `
      <div class="selection-title">${Object.entries(names).map(([type, count]) => `${label(type)} x${count}`).join(", ")}</div>
      <div class="selection-detail">${ownership}${first.hp ? ` · ${Math.round(first.hp)}/${first.maxHp} hp` : ""}${carried}${resource}${farm}</div>
    `;
    this.renderActions(selected);
  }

  renderActions(selected) {
    const actions = [];
    const ownedUnits = selected.filter((entity) => entity.kind === "unit" && entity.ownerId === this.state.playerId);
    const ownedBuildings = selected.filter((entity) => entity.kind === "building" && entity.ownerId === this.state.playerId);
    const hasVillager = ownedUnits.some((entity) => entity.type === "villager");
    if (hasVillager) {
      for (const [buildingType, def] of Object.entries(BUILDINGS)) {
        actions.push({ spriteName: buildingType, label: def.label, cost: def.cost, action: () => this.actions.setBuildMode(buildingType) });
      }
    }
    for (const building of ownedBuildings) {
      if (building.type === "farm") {
        const player = this.state.snapshot.players[this.state.playerId];
        actions.push({ spriteName: "farm", label: player.autoReplenishFarms ? "Auto reseed: on" : "Auto reseed: off", cost: {}, action: () => this.actions.toggleAutoFarm() });
        actions.push({ spriteName: "farm", label: "Reseed farm", cost: { wood: 45 }, action: () => this.actions.replenishFarm(building.id), forceDisabled: !building.exhausted && building.amount > 0 });
      }
      if (building.queue?.length) {
        const first = building.queue[0];
        actions.push({ queue: true, label: `Training ${building.queue.length}/10`, detail: `${Math.max(0, Math.round(first.remaining))}s` });
      }
      for (const train of TRAINING[building.type] || []) {
        actions.push({ spriteName: train.unitType, label: train.label, cost: train.cost, action: () => this.actions.train(building.id, train.unitType), forceDisabled: building.queue?.length >= 10 });
      }
    }
    this.renderActionSet(actions);
  }

  renderActionSet(actions) {
    const player = this.state.snapshot.players[this.state.playerId];
    const signature = JSON.stringify(actions.map((action) => ({
      queue: action.queue,
      spriteName: action.spriteName,
      label: action.label,
      detail: action.detail,
      cost: action.cost,
      disabled: action.forceDisabled || !canAfford(player.resources, action.cost || {}),
    })));
    if (signature === this.actionSignature) return;
    this.actionSignature = signature;
    this.actionsEl.innerHTML = "";
    this.hideHover();
    for (const action of actions) {
      if (action.queue) this.addQueue(action.label, action.detail);
      else this.addButton(action.spriteName, action.label, action.cost, action.action, action.forceDisabled);
    }
  }

  addQueue(label, detail) {
    const queue = document.createElement("div");
    queue.className = "queue";
    queue.innerHTML = `<strong>${escapeHtml(label)}</strong><span>${escapeHtml(detail)}</span>`;
    this.actionsEl.append(queue);
  }

  addButton(spriteName, label, cost = {}, onPointerDown, forceDisabled = false) {
    const player = this.state.snapshot.players[this.state.playerId];
    const disabled = forceDisabled || !canAfford(player.resources, cost);
    const button = document.createElement("button");
    button.className = "action";
    button.disabled = disabled;
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.dataset.label = label;
    button.dataset.cost = formatCost(cost);
    button.dataset.disabledReason = disabled ? disabledReason(player.resources, cost, forceDisabled) : "";
    button.append(icon(spriteName));
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!button.disabled) onPointerDown();
    });
    button.addEventListener("mouseenter", () => this.showHover(button));
    button.addEventListener("mousemove", () => this.showHover(button));
    button.addEventListener("mouseleave", () => this.hideHover());
    this.actionsEl.append(button);
  }

  showHover(button) {
    const cost = button.dataset.cost || "free";
    const disabled = button.dataset.disabledReason;
    this.hoverCard.innerHTML = `
      <div class="hover-title">${escapeHtml(button.dataset.label)}</div>
      <div class="hover-line">Cost: ${escapeHtml(cost)}</div>
      ${disabled ? `<div class="hover-warning">${escapeHtml(disabled)}</div>` : ""}
    `;
    const rect = button.getBoundingClientRect();
    this.hoverCard.classList.remove("hidden");
    this.hoverCard.style.left = `${Math.round(rect.left)}px`;
    this.hoverCard.style.top = `${Math.round(rect.top - this.hoverCard.offsetHeight - 10)}px`;
  }

  hideHover() {
    this.hoverCard.classList.add("hidden");
  }

  showToast(text) {
    this.lastToast = text;
    this.toast.textContent = text;
    this.toast.classList.add("visible");
    window.setTimeout(() => this.toast.classList.remove("visible"), 2400);
  }
}

function label(type) {
  return type.replace(/[A-Z]/g, (char) => ` ${char}`).replace(/^./, (char) => char.toUpperCase());
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function canAfford(resources, cost) {
  return Object.entries(cost).every(([resource, amount]) => (resources[resource] || 0) >= amount);
}

function formatCost(cost) {
  const text = Object.entries(cost).map(([resource, amount]) => `${amount} ${resource}`).join(", ");
  return text || "free";
}

function disabledReason(resources, cost, forceDisabled) {
  if (forceDisabled) return "Unavailable right now";
  const missing = Object.entries(cost).filter(([resource, amount]) => (resources[resource] || 0) < amount);
  if (!missing.length) return "";
  return `Need ${missing.map(([resource, amount]) => `${amount - Math.floor(resources[resource] || 0)} more ${resource}`).join(", ")}`;
}

function icon(spriteName) {
  const canvas = document.createElement("canvas");
  canvas.className = "action-icon";
  canvas.width = 56;
  canvas.height = 56;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const rows = sprites[spriteName] || sprites.house;
  const scale = Math.max(1, Math.floor(52 / Math.max(rows.length, rows[0].length)));
  const ox = Math.floor((56 - rows[0].length * scale) / 2);
  const oy = Math.floor((56 - rows.length * scale) / 2);
  for (let y = 0; y < rows.length; y += 1) {
    for (let x = 0; x < rows[y].length; x += 1) {
      const key = rows[y][x];
      const color = key === "p" ? "#4f8fd8" : key === "P" ? "#7eb2ee" : palette[key];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale);
    }
  }
  return canvas;
}

function resourcePill(resource, amount) {
  return `<span class="resource-pill" title="${resource}">${resourceIcon(resource)}<strong>${amount}</strong></span>`;
}

function resourceIcon(resource) {
  const grids = {
    wood: [
      ".WW.",
      "bWWb",
      ".WW.",
      "b..b",
    ],
    food: [
      ".LL.",
      "LllL",
      ".ll.",
      "..W.",
    ],
    ore: [
      ".QQ.",
      "QMMQ",
      ".MQ.",
      "....",
    ],
  };
  const colors = {
    ".": "transparent",
    W: "#6a4a32",
    b: "#8b623e",
    L: "#6fa04a",
    l: "#5a7f38",
    Q: "#c1b77b",
    M: "#9aa3a0",
  };
  const pixels = grids[resource].flatMap((row, y) =>
    [...row].map((key, x) => `<i style="left:${x * 4}px;top:${y * 4}px;background:${colors[key]}"></i>`),
  ).join("");
  return `<span class="resource-icon" aria-hidden="true">${pixels}</span>`;
}
