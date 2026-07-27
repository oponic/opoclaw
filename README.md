# opoclaw
opoclaw is an OpenClaw alternative built in Bun made to be fast and sandboxed. It is entirely safe to run by default, simple and easy to use, and a polished experience.
|                       | **Opoclaw**          | OpenClaw   | NanoClaw   | PicoClaw |
|-----------------------|----------------------|------------|------------|----------|
| Language              | **Bun (TypeScript)** | TypeScript | TypeScript | Go       |
| RAM                   | **<100 MB**           | <1 GB      | <500 MB    | <10 MB   |
| Startup (0.8GHz core) | **1.5s**              | <500s      | <30s       | <1s      |
## Getting Started
You can find the installation scripts in the Releases tab, or copy one of these for your operating system:

macOS and Linux: `curl -fsSL https://raw.githubusercontent.com/oponic/opoclaw/refs/heads/main/installers/setup.sh | bash`

Windows: `irm https://raw.githubusercontent.com/oponic/opoclaw/refs/heads/main/installers/setup.ps1 | iex`

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
