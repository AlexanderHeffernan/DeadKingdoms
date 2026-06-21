export const TICK_RATE = 10;
export const TICK_MS = 1000 / TICK_RATE;
export const MAX_PLAYERS = 10;
export const MAP_SIZE = 256;
export const TILE_W = 64;
export const TILE_H = 32;

export const RESOURCE_TYPES = ["wood", "food", "ore"] as const;

export const STARTING_RESOURCES = {
	wood: 300,
	food: 300,
	ore: 150,
};

export const COLORS = [
	"#4f8fd8",
	"#d8574f",
	"#e3b64f",
	"#56b36b",
	"#b56bd8",
	"#d88c4f",
	"#4fd8c8",
	"#d84f96",
	"#9fa7b3",
	"#80c34f",
];

export const STARTING_UNITS = [
	{ unitType: "soldier", x: 5.0, y: 5.0 },
	{ unitType: "villager", x: 3.0, y: 5.0 },
	{ unitType: "villager", x: 1.0, y: 5.0 },

	{ unitType: "villager", x: 5.0, y: 3.0 },
] as const;

export const RESOURCE_DEFS = {
	tree: {
		label: "Tree",
		sprite: "tree",
		resource: "wood",
		amount: 100,
		score: 0,
	},
	ore: {
		label: "Stone",
		sprite: "ore",
		resource: "ore",
		amount: 350,
		score: 0,
	},
	berry: {
		label: "Berry Bush",
		sprite: "berry",
		resource: "food",
		amount: 125,
		score: 0,
	},
} as const;

export const ACTION_SOUND_DEFS = {
	chopWood: { sound: 46, duration: 0.1 },
	mineOre: { sound: 58, duration: 0.1 },
	gatherFood: { sound: 30, duration: 0.1 },
	build: { sound: 60, duration: 0.1 },
	unitAttack: { sound: 60, duration: 0.1 },
	towerAttack: { sound: 30, duration: 0.1 },
	trainUnit: { sound: 0, duration: 0.1 },
	buildingDestroyed: { sound: 420, duration: 5 },
} as const;
