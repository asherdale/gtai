# GTAI: Vibe City

How long can your AI agent survive a 5-star wanted level?

You write a getaway plan, pick a driver, and an AI agent drives a stolen car
through San Francisco while the police close in. It decides at every
intersection, live, until it gets busted. Play it at
[gta.fly.dev](https://gta.fly.dev).

## How it works

Every chase is its own [Omnara](https://www.omnara.com) agent. The driver
profiles in [`agents/`](agents) are the same apart from the model, and each
has one custom tool, `drive`.

1. You write a getaway plan and pick a driver. [`server.mjs`](server.mjs)
   starts a new agent with your plan and the first intersection.
2. At every intersection the agent calls `drive` with an exit, a speed and a
   line of dialogue. Omnara doesn't run custom tools itself: the server sees
   the call on the agent's event stream ([`runner.mjs`](runner.mjs)),
   advances the simulation ([`sim.mjs`](sim.mjs)) and posts the next
   intersection back as the tool's result.
3. Police patrol the city, set roadblocks and send a helicopter at 5 stars.
   The chase ends when a patrol car catches you or at 6:00, and your time goes
   on the leaderboard.
4. **Run it back** sends the same agent out again with the same plan, up to
   three runs. It remembers how it got caught last time.

The agent only ever sees the scene in words. Plans and the driver's lines are
checked with OpenAI's free moderation endpoint, and share cards are drawn
with [`card.mjs`](card.mjs).

## Run your own

Open this repository in Claude Code, Codex, Cursor, or another coding agent
and say:

```text
Follow SKILL.md to set up GTAI.
```

Or by hand, with Node 24 or newer:

1. Create an org API key in the [Omnara dashboard](https://app.omnara.com):
   with **All projects** selected, open **Access → API Tokens** and click
   **New token**. Give it the `admin` org role, or the `member` role plus the
   `developer` role on your project.
2. Copy `.env.example` to `.env` and fill in the key, your org and project
   IDs, and an [OpenAI API key](https://platform.openai.com/api-keys) for
   moderation. Moderation is free, and optional when you run locally.
3. Run:

   ```sh
   npm install
   npm run setup   # creates a driver profile for each model your project can use
   npm start       # http://localhost:8787
   ```

`npm run setup` reads every `agents/driver-*.yaml`, skips models that aren't
granted to your project, creates or updates a `gtai-driver-<name>` profile for
the rest, and writes their IDs to `agents/profiles.txt`. To add a driver,
copy a YAML file, change `model.name`, and run it again.

`npm run simulate` drives 150 chases with simple scripted drivers and needs
no keys. Use it to check that a change to [`sim.mjs`](sim.mjs) keeps the
game fair.

## Deploy

[`fly.toml`](fly.toml) runs the server on [Fly.io](https://fly.io) with a
volume for chases and cards. Run `npm run setup` first, because the image
includes `agents/profiles.txt`.

```sh
fly apps create <app-name>
fly volumes create chase_data --app <app-name> --region sjc --size 1
fly secrets set --app <app-name> OMNARA_API_KEY=... OMNARA_ORG_ID=... \
  OMNARA_PROJECT_ID=... OPENAI_API_KEY=...
fly deploy --app <app-name>
```

The server refuses to start in production without `OPENAI_API_KEY`. Other
settings, all optional:

| Variable | Default | What it does |
| --- | --- | --- |
| `CONCURRENCY` | `3` | Chases that run at once; the rest wait in line |
| `MAX_PER_HOUR` | `8` | Chases one IP address can start per hour |
| `PUBLIC_URL` | the request's host | Base URL for share links and cards |
| `REPO_URL` | none | Adds a **GitHub** link to the nav and a **View the code** button to the How it works page |

## Map data

The street graph, parks, coastline and buildings in [`data/`](data) were
built from [OpenStreetMap](https://www.openstreetmap.org/copyright) data,
© OpenStreetMap contributors. They're available under the
[Open Database License](https://opendatacommons.org/licenses/odbl/), not the
Apache license that covers the code. Elevations come from the
[Open-Meteo](https://open-meteo.com) elevation API
([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)), based on the
Copernicus DEM GLO-90.

GTAI is a fan parody and isn't affiliated with Rockstar Games.
