export const TILE_W = 64;
export const TILE_H = 32;
export const SCALE = 4;

export const BUILDINGS = {
  house: { label: "House", cost: { wood: 35 } },
  farm: { label: "Farm", cost: { wood: 45 } },
  barracks: { label: "Barracks", cost: { wood: 120, ore: 30 } },
  watchTower: { label: "Watch Tower", cost: { wood: 80, ore: 45 } },
  lumberCamp: { label: "Lumber Camp", cost: { wood: 70 } },
  miningCamp: { label: "Mining Camp", cost: { wood: 70 } },
};

export const TRAINING = {
  townCenter: [{ unitType: "villager", label: "Villager", cost: { food: 45 } }],
  barracks: [{ unitType: "soldier", label: "Soldier", cost: { food: 45, ore: 20 } }],
};
