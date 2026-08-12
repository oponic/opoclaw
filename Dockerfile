FROM oven/bun:1.1.24

# Deno is a required runtime: Opoclaw exposes the sandboxed TypeScript tool by default.
RUN apt-get update && apt-get install -y --no-install-recommends unzip ca-certificates curl \
    && curl -fsSL https://deno.land/install.sh | sh \
    && ln -s /root/.deno/bin/deno /usr/local/bin/deno \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY docs ./docs
COPY installers ./installers

# Pre-cache the supported Deno libraries so sandbox calls work without granting
# runtime network permission. The bridge keeps imports restricted to this set.
RUN deno eval 'import "jsr:@std/encoding@1.0.10/hex"; import "npm:zod@3.24.2"; import "npm:lodash@4.17.21";'

ENV OPOCLAW_CONFIG_PATH=/app/config.toml

# Run the gateway in the foreground — `cli.ts gateway start` detaches a child
# and exits, which would terminate the container immediately.
CMD ["bun", "run", "src/index.ts"]
