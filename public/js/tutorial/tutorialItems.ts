import { TutorialItem, type TutorialEvent } from "./tutorialItem.js";

class MoveUnitTutorialItem extends TutorialItem {
	protected completedOn(event: TutorialEvent) {
		return event.command.type === "move";
	}
	getText(): string { return "Select a villager, then right-click on the map to move it."; }
}

class GatherResourceTutorialItem extends TutorialItem {
	protected completedOn(event: TutorialEvent) {
		return event.command.type === "gather";
	}
	getText(): string { return "Select a villager, then right-click a resource to gather it."; }
}

class BuildBuildingTutorialItem extends TutorialItem {
	protected completedOn(event: TutorialEvent) {
		return event.command.type === "build";
	}
	getText(): string { return "Select a villager, choose a building from the build menu in the bottom-left corner, then place it on the map."; }
}

export function createTutorialItems(): TutorialItem[] {
	return [new MoveUnitTutorialItem(), new GatherResourceTutorialItem(), new BuildBuildingTutorialItem()];
}
