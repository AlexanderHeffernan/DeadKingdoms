import { escapeHtml } from "./dom.js";

export class HoverCard {
	private readonly el: HTMLDivElement;

	constructor() {
		this.el = document.createElement("div");
		this.el.className = "action-hover hidden";
		document.body.append(this.el);
	}

	showAction(button: HTMLElement) {
		const cost = button.dataset.cost || "free";
		const disabled = button.dataset.disabledReason;
		this.el.innerHTML = `
			<div class="hover-title">${escapeHtml(button.dataset.label ?? "")}</div>
			${button.dataset.description ? `<div class="hover-line">${escapeHtml(button.dataset.description ?? "")}</div>` : ""}
			<div class="hover-line hover-cost-line"><span>Cost:</span> ${cost}</div>
			${button.dataset.shortcut ? `<div class="hover-line">Shortcut: ${escapeHtml(button.dataset.shortcut ?? "")}</div>` : ""}
			${disabled ? `<div class="hover-warning">${escapeHtml(disabled ?? "")}</div>` : ""}
		`;
		const rect = button.getBoundingClientRect();
		this.el.classList.remove("hidden");
		this.el.style.left = `${Math.round(rect.left)}px`;
		this.el.style.top = `${Math.round(rect.top - this.el.offsetHeight - 10)}px`;
	}

	showInfo(target: HTMLElement) {
		this.el.innerHTML = `
			<div class="hover-title">${escapeHtml(target.dataset.hoverTitle || "")}</div>
			<div class="hover-line">${escapeHtml(target.dataset.hoverDetail || "")}</div>
		`;
		const rect = target.getBoundingClientRect();
		this.el.classList.remove("hidden");
		this.el.style.left = `${Math.round(rect.left)}px`;
		this.el.style.top = `${Math.round(rect.bottom + 8)}px`;
	}

	hide() {
		this.el.classList.add("hidden");
	}
}
