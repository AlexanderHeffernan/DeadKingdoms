# Persistent RTS Arena

A browser-playable multiplayer RTS MVP inspired by persistent arena games and classic isometric RTS controls.

Play the live version at <https://rts.alexheffernan.dev>.

## Run with Node.js

Requires Node.js 20 or newer. No install step is required; the app currently has
no runtime npm dependencies.

```sh
node src/server/index.js
```

Open `http://127.0.0.1:3000`.

## Run with Docker

Build and run the game on your machine or server:

```sh
docker build -t persistent-rts-arena:latest .
docker compose up -d
```

Open `http://SERVER_IP:3000`.

Useful commands:

```sh
docker compose logs -f rts
docker compose down
```

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
