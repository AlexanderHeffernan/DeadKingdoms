# Persistent RTS Arena

A browser-playable multiplayer RTS MVP inspired by persistent arena games and classic isometric RTS controls.

## Run

```sh
node src/server/index.js
```

Open `http://127.0.0.1:3000`.

No install step is required. The first pass uses plain Node.js, HTTP commands, and Server-Sent Events.

## MVP Scope

- One running server hosts one world.
- Up to 10 players can join with a username.
- No accounts and no player persistence after defeat/disconnect.
- The world persists while the server is running.
- Isometric canvas renderer.
- Drag-select units and right-click commands.
- Villagers gather wood/ore/food.
- Farms, houses, barracks, watch towers, town centers, trees, ore, villagers, and soldiers.
- Simple combat, destruction, ruins, and leaderboard.
