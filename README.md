# opoclaw [light]
opoclaw light is a branch of opoclaw made to be extremely lightweight; cutting out multiple features in favor of lower CPU and RAM usage.
|                       | **Opoclaw [light]**          | Opoclaw   | OpenClaw   | NanoClaw |
|-----------------------|----------------------|------------|------------|----------|
| Language              | **TypeScript** | TypeScript | TypeScript | TypeScript       |
| RAM                   | **51 MB**           | <100 MB      | <1 GB    | <500 MB   |
| Startup (0.8GHz core) | **0.8s**              | 1.5s      | <30s       | <15s      |
## Getting Started
opoclaw light only runs on Linux.

First, download opoclaw light.

`cd ~/Documents; git clone https://github.com/oponic/opoclaw.git; cd opoclaw; git checkout light`

Make sure you have Bun installed.

Set up opoclaw services:

`bun . install; source ~/.bashrc` (or ~/.zshrc)

Finally, you can begin onboarding, and finish up the setup.

`opoclaw onboard`
## Docker
Build and run with Docker (network access is enabled by default, required for search/web fetch):

```bash
docker build -t opoclaw .
docker run --rm -it \
  -v "$PWD/config.toml:/app/config.toml" \
  -v "$PWD/workspace:/app/workspace" \
  -v "$PWD/usage.json:/app/usage.json" \
  opoclaw
```

Or with Docker Compose:

```bash
docker compose up --build -d
```
