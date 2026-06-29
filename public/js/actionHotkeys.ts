export interface HotkeyAction {
	run: () => void;
	enabled: boolean;
}

const STORAGE_KEY = "rtsActionHotkeys";
const DEFAULT_KEYS = ["q", "w", "e", "r", "a", "s", "d", "f", "z", "x", "c", "v"] as const;

export class ActionHotkeys {
	private keys = this.loadKeys();
	private actions: HotkeyAction[] = [];
	private readonly changeListeners = new Set<() => void>();

	setActions(actions: HotkeyAction[]) {
		this.actions = actions;
	}

	handleKeyDown(event: KeyboardEvent) {
		if (!this.isEligible(event)) return false;
		const position = this.keys.indexOf(this.normalizeKey(event.key));
		if (position < 0) return false;
		const action = this.actions[position];
		if (!action) return false;
		event.preventDefault();
		if (action.enabled) action.run();
		return true;
	}

	getKeys() {
		return [...this.keys];
	}

	getDisplayKey(position: number) {
		return this.keys[position]?.toUpperCase() ?? "";
	}

	setKey(position: number, key: string) {
		const normalized = this.normalizeKey(key);
		if (!this.isSupportedKey(normalized)) return "Choose a letter, number, or punctuation key.";
		const duplicatePosition = this.keys.indexOf(normalized);
		if (duplicatePosition >= 0 && duplicatePosition !== position) return `${normalized.toUpperCase()} is already assigned.`;
		if (position < 0 || position >= this.keys.length) return "Unknown action position.";
		this.keys[position] = normalized;
		this.saveAndNotify();
		return null;
	}

	reset() {
		this.keys = [...DEFAULT_KEYS];
		this.saveAndNotify();
	}

	onChange(listener: () => void) {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	private isEligible(event: KeyboardEvent) {
		if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return false;
		if (document.getElementById("game")?.classList.contains("hidden")) return false;
		if (!document.getElementById("settingsModal")?.classList.contains("hidden")) return false;
		return !(event.target instanceof HTMLElement && event.target.matches("input, textarea, select, button, [contenteditable='true']"));
	}

	private normalizeKey(key: string) {
		return key.toLowerCase();
	}

	private isSupportedKey(key: string) {
		return key.length === 1 && !/\s/.test(key);
	}

	private loadKeys() {
		try {
			const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
			if (Array.isArray(stored) && stored.length === DEFAULT_KEYS.length && stored.every((key) => typeof key === "string" && this.isSupportedKey(key)) && new Set(stored).size === stored.length) {
				return stored.map((key) => this.normalizeKey(key));
			}
		} catch {
			// Ignore malformed local settings and restore the defaults.
		}
		return [...DEFAULT_KEYS];
	}

	private saveAndNotify() {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(this.keys));
		for (const listener of this.changeListeners) listener();
	}
}
