---
name: setup-gtai
description: Set up, run, or deploy GTAI: Vibe City, a police-chase game where an Omnara agent drives a getaway car through San Francisco one intersection at a time. Use when the user asks to set up, run, deploy, update, or remove GTAI.
---

# Set up GTAI: Vibe City

You are setting up the driver profiles from `agents/` in the user's Omnara
project and running the game server. The goal: the user has watched an AI
agent drive a chase at `http://localhost:8787`, and, if they want it public,
the game is deployed.

- Skip anything that's already done, and follow the user's lead on order.
- If a command fails, `npx omnara <command> --help` and
  [docs.omnara.com](https://docs.omnara.com) have the details.
- Never print or commit `.env`; it holds API keys.

## 1. Get an Omnara API key

The server and `npm run setup` both use an org API key. Only a person can
create one, in the dashboard. Ask the user to:

1. Open [app.omnara.com](https://app.omnara.com), select **All projects** in
   the project switcher, open **Access → API Tokens**, and click **New
   token**.
2. Pick the `admin` org role, or `member` plus the `developer` role on the
   project they want to use (the key's detail panel grants project roles).
3. Paste the token and the org and project IDs into `.env`, copied from
   `.env.example`. If they're logged in to the CLI, `npx omnara whoami --json`
   and `npx omnara projects list --org <org-id> --json` show the IDs.

`OPENAI_API_KEY` is optional locally and required in production: the server
checks every getaway plan and every line the driver says with OpenAI's free
moderation endpoint.

## 2. Create the driver profiles

```sh
npm install
npm run setup
```

It creates or updates one `gtai-driver-<name>` profile for each
`agents/driver-*.yaml` whose model is granted to the project, skips the rest,
and writes `agents/profiles.txt`. Tell the user which drivers it skipped. If
they want one of those, check `npx omnara grant models list --json`: either
point the YAML's `model.name` at a granted model, or add the model with
`npx omnara models create` and `npx omnara grant models add`, then run
`npm run setup` again.

## 3. Drive a chase

Run `npm start` and open `http://localhost:8787`. Ask the user to write a
getaway plan, pick a driver, and start the chase. Each chase is an Omnara
agent, and it shows up under the project's agents in the Omnara dashboard.

If a chase fails to start, the server log says why. The usual causes are a
key without access to the project, or a profile whose model was removed.

## 4. Deploy (optional)

Deploy on [Fly.io](https://fly.io) if the user wants it public. Ask for an app
name and use their Fly account (`fly auth whoami`); ask before running any
command that creates resources or costs money.

```sh
fly apps create <app-name>
fly volumes create chase_data --app <app-name> --region sjc --size 1
fly secrets set --app <app-name> OMNARA_API_KEY=... OMNARA_ORG_ID=... \
  OMNARA_PROJECT_ID=... OPENAI_API_KEY=...
fly deploy --app <app-name>
```

Set the secrets from `.env` without echoing them. The image includes
`agents/profiles.txt`, so run `npm run setup` before every deploy that adds or
removes a driver. `PUBLIC_URL` and `REPO_URL` are optional; see the README.

## 5. Wrap up

Tell the user:

- **Balance changes:** `npm run simulate` drives 150 scripted chases with no
  keys, so they can check a change to `sim.mjs` before deploying.
- **Remove it:** delete each profile listed in `agents/profiles.txt` with
  `npx omnara profiles delete <agent-profile-id>`, and on Fly,
  `fly apps destroy <app-name>`.
