import type { ClientCommand } from "../clientTypes.js";

export type TutorialEvent = {
	type: "commandSucceeded";
	command: ClientCommand;
};

export abstract class TutorialItem {
	private complete = false;

	isComplete() {
		return this.complete;
	}

	update(event: TutorialEvent) {
		if (!this.complete && this.completedOn(event)) this.complete = true;
	}

	abstract getText(): string;

	protected abstract completedOn(event: TutorialEvent): boolean;
}
