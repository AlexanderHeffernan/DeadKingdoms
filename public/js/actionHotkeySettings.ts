import type { ActionHotkeys } from "./actionHotkeys.js";

export class ActionHotkeySettings {
	private readonly grid: HTMLElement;
	private readonly status: HTMLElement;
	private capturingPosition: number | null = null;

	constructor(private readonly hotkeys: ActionHotkeys) {
		this.grid = this.requireElement("actionHotkeyGrid");
		this.status = this.requireElement("actionHotkeyStatus");
	}

	wireDom() {
		this.render();
		this.grid.addEventListener("click", (event) => this.beginCapture(event));
		document.addEventListener("keydown", (event) => this.captureKey(event), true);
		document.getElementById("resetActionHotkeysButton")?.addEventListener("click", () => this.reset());
		this.hotkeys.onChange(() => this.render());
	}

	private beginCapture(event: MouseEvent) {
		if (!(event.target instanceof Element)) return;
		const button = event.target.closest<HTMLButtonElement>("button[data-position]");
		if (!button) return;
		this.capturingPosition = Number(button.dataset.position);
		this.status.textContent = `Press a new key for action ${this.capturingPosition + 1}, or Escape to cancel.`;
		this.status.classList.remove("error");
		this.render();
		this.grid.querySelector<HTMLButtonElement>(`button[data-position="${this.capturingPosition}"]`)?.focus();
	}

	private captureKey(event: KeyboardEvent) {
		if (this.capturingPosition === null) return;
		event.preventDefault();
		event.stopPropagation();
		if (event.key === "Escape") {
			this.capturingPosition = null;
			this.status.textContent = "Shortcut change cancelled. Select a key to try again; press Escape while editing to cancel.";
			this.status.classList.remove("error");
			this.render();
			return;
		}
		const position = this.capturingPosition;
		const error = this.hotkeys.setKey(position, event.key);
		if (!error) this.capturingPosition = null;
		this.status.textContent = error ?? `Action ${position + 1} assigned to ${this.hotkeys.getDisplayKey(position)}.`;
		this.status.classList.toggle("error", Boolean(error));
		this.render();
	}

	private reset() {
		this.capturingPosition = null;
		this.hotkeys.reset();
		this.status.textContent = "Action shortcuts restored to defaults.";
		this.status.classList.remove("error");
	}

	private render() {
		this.grid.innerHTML = "";
		for (const [position, key] of this.hotkeys.getKeys().entries()) {
			const button = document.createElement("button");
			button.type = "button";
			button.dataset.position = String(position);
			button.classList.toggle("active", position === this.capturingPosition);
			button.setAttribute("aria-pressed", String(position === this.capturingPosition));
			button.setAttribute("aria-label", `Change shortcut for action position ${position + 1}`);
			button.innerHTML = `<span>${position + 1}</span><strong>${key.toUpperCase()}</strong>`;
			this.grid.append(button);
		}
	}

	private requireElement(id: string) {
		const element = document.getElementById(id);
		if (!element) throw new Error(`Missing #${id}`);
		return element;
	}
}
