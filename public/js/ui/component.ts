import type { ClientSnapshot } from "../clientTypes.js";

export interface GameUiComponent {
	render(snapshot: ClientSnapshot): void;
}
