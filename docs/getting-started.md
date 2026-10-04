# Getting started

## Requirements

- Node 22.12 or newer (`.nvmrc` pins the tested version)
- Python 3.11 or newer (only for the deterministic engine)

## Install

```bash
git clone https://github.com/aniruddhaadak80/tickrate-sim.git
cd tickrate-sim
npm install
```

## Verify the install

```bash
tickrate-sim doctor
```

`doctor` probes the runtime, the skill catalog, the plugin registry, and the config, and
prints a fix hint for anything that fails. It is the fastest way to confirm a working
install.

## First run

```bash
tickrate-sim tools --json        # what this build can do
tickrate-sim skills --json       # the skill catalog
tickrate-sim run <tool-name> --input '{"example":"value"}'
```

## Run the web app

```bash
npm run build
cd apps/web && npm run start
```

Then open <http://localhost:3000> and check <http://localhost:3000/api/health>.

## Run the tests

```bash
npm test            # TypeScript, every package
npm run pytest      # the Python engine
```
