# Dead Kingdoms

Dead Kingdoms is a browser-playable multiplayer RTS where you build a kingdom in a world that refuses to stay buried. Gather resources, raise walls, train armies, fight rival players, and survive the dead as they spread across the map.

Play the live alpha at <https://deadkingdoms.alexheffernan.dev>.

Dead Kingdoms is open source and self-hostable. The official server is small enough to run on a Raspberry Pi, and anyone can host a world for friends from their own machine.

## Current Alpha

Dead Kingdoms is past the early MVP stage, but it is still an active alpha. The core loop is playable, the architecture is growing, and the issue tracker is the best place to find work that would make the game better.

The project is especially interested in contributors who enjoy RTS systems, browser games, server-authoritative multiplayer, game feel, AI, performance, and small-server deployment.

## Features

- Browser-based RTS gameplay with classic isometric controls.
- Multiplayer arena world for up to 10 players.
- Server-authoritative simulation for commands, combat, resources, construction, training, zombies, and world state.
- Persistent world state while the server is running.
- Playable factions that gather wood, food, and ore, then build and defend a growing base.
- Zombies that rise, roam, hear noise, attack settlements, and pressure the whole map.
- Fog of war, minimap, selection, rally points, building placement, walls, gates, farms, depots, watch towers, barracks, town centers, villagers, scouts, archers, soldiers, and more.
- Global leaderboard with world snapshot previews.
- Admin and diagnostics tools for running public servers.
- Music, sound effects, and RTS-style UI feedback.
- Docker deployment with persistent leaderboard storage.
- Pathing and zombie director tests and benchmarks.

## Tech Stack

- TypeScript
- Node.js HTTP server
- Server-sent events for live game updates
- PixiJS client rendering
- esbuild client bundling
- Docker and Docker Compose

The server owns the game rules. The client focuses on rendering, input, UI state, sound, and displaying authoritative snapshots from the server.

## Run Locally

Requires Node.js 20 or newer.

```sh
npm install
npm run dev
```

Open <http://127.0.0.1:3000>.

The default port is `3000`. You can override it with `PORT`:

```sh
PORT=8080 npm run dev
```

## Build And Start

```sh
npm install
npm run build
npm start
```

## Host With Docker

Build the image and start a self-hosted game server:

```sh
docker build -t dead-kingdoms:latest .
RTS_IMAGE=dead-kingdoms:latest docker compose up -d
```

Open `http://SERVER_IP:3000`.

Useful commands:

```sh
docker compose logs -f rts
docker compose down
```

The Compose setup stores leaderboard data in a Docker volume and includes Watchtower support for simple image updates.

## Configuration

Optional environment variables:

- `PORT`: HTTP port, defaulting to `3000`.
- `LEADERBOARD_DATA_DIR`: directory for global leaderboard data, defaulting to `data` locally and `/data` in Docker.
- `DEV_ADMIN_SECRET`: enables protected admin/dev tools when set.

Copy `.env.example` to `.env` if you want local environment variables:

```sh
cp .env.example .env
```

## Scripts

```sh
npm run dev             # Build server/client and run a local game server
npm run build           # Build changelog, server, and client bundle
npm run start           # Run the built server
npm run typecheck       # Typecheck server and client TypeScript
npm run test:pathing    # Run pathfinding tests
npm run test:zombies    # Run zombie director tests
npm run bench:pathing   # Run pathfinding benchmarks
npm run bench:zombies   # Run zombie director benchmarks
```

## Project Layout

```text
src/server/             Server runtime, world simulation, pathing, zombie systems, leaderboard
src/shared/             Shared game types, config, units, buildings, messages
public/js/              Browser client, renderer, UI, controls, audio, API client
public/                 HTML, CSS, fonts, generated client assets
assets/                 Soundtrack, SFX sources, visual experiments
scripts/                Build helpers
```

## Architecture Notes

Dead Kingdoms is moving toward a clean object-oriented game architecture:

- Units live in concrete classes such as `VillagerUnit`, `SoldierUnit`, `ArcherUnit`, `ScoutUnit`, and `ZombieUnit`.
- Buildings live in concrete classes such as `TownCenter`, `Barracks`, `Farm`, `WatchTower`, `Wall`, `Gate`, and resource depots.
- Unit and building registries provide dynamic dispatch instead of large external type switches.
- The server remains the source of truth for gameplay decisions.
- Tests and benchmarks cover performance-sensitive systems like pathing and the zombie director.

## Contributing

Dead Kingdoms is open source, and contributions are welcome.

Good places to start:

- Play the live game and open issues for bugs, rough edges, or balance problems.
- Pick up existing GitHub issues.
- Improve game feel, UI, sound, performance, pathing, zombie behavior, buildings, units, or deployment docs.
- Add focused tests when changing shared gameplay behavior.

Before opening a pull request, run the smallest useful verification for your change. For shared gameplay work, this usually means:

```sh
npm run typecheck
npm run test:pathing
npm run test:zombies
```

## Credits

- UI font: [C&C Red Alert](https://www.dafont.com/c-c-red-alert-inet.font) by N3tRunn3r, distributed as 100% freeware. The original font README is included at `public/fonts/red-alert-inet-README.txt`.
- Music: generated with [Suno](https://suno.com/). Tracks created on Suno's free/basic plan are credited to Suno and are included for non-commercial project use.
- Sound effects: created with [Bfxr](https://www.bfxr.net/).
- Artwork: created by contributors to this project.

## License

MIT. See [LICENSE](LICENSE). Third-party assets and generated media remain subject to their own terms.
