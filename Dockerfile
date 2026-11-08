# pro-fetch MCP server — container image
#
# NOT BUILT OR RUN HERE. This machine has no Docker (`docker: command not found`), so nothing in this file
# is a claim that it works. The verification command is at the bottom, and until it has been run this file
# should be read as a reviewed intent, not a tested artifact.
#
# Why the Playwright base image rather than `node:slim`: the second stage of the reader starts a headless
# Chromium. On a slim image that means `npx playwright install --with-deps chromium` at build time, which
# pulls the system libraries Chromium will not run without (fontconfig, libnss, libatk, libdrm and the rest).
# The official image already carries them and pins the browser build to the Playwright version, which is the
# combination that actually starts.
#
# The tag below is deliberately pinned to a major.minor that this repository's Playwright dependency
# supports. Check `node_modules/playwright/package.json` version and use the matching tag before building;
# a floating `latest` makes the browser build change without anyone deciding it.
FROM mcr.microsoft.com/playwright:v1.49.1-noble

# Node ships with the Playwright image; this only records the requirement the package also declares.
ENV NODE_ENV=production
ENV npm_config_update_notifier=false

WORKDIR /app

# Dependencies first, so a source-only change does not re-resolve the tree.
# `--include=dev` is needed for the build step (tsc); the dev deps are dropped after compiling.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY . .

RUN npm run build \
  && npm prune --omit=dev \
  && rm -rf src tests scripts docs .git

# Non-root. The reader writes its cache and browser profiles under HOME, so that directory is owned.
RUN useradd -m -u 10001 profetch && chown -R profetch:profetch /app /home/profetch
USER profetch

# The browser pool default (2 processes) is sized for ~1 GB of RAM each. Raise the container memory before
# raising PRO_FETCH_BROWSER_POOL_SIZE, and keep PRO_FETCH_BROWSER_POOL_MAX_PAGES finite: a Chromium that
# runs for hours accumulates memory, and the restart is cheaper than the debugging.
ENV PRO_FETCH_BROWSER_POOL_SIZE=2
ENV PRO_FETCH_BROWSER_POOL_MAX_PAGES=50
ENV PRO_FETCH_BROWSER_POOL_IDLE_MS=60000
# The contact address a site operator can write to. Override this with your own page.
ENV PRO_FETCH_USER_AGENT_CONTACT=https://github.com/Pro-Fetch/ProFetch

# stdio MCP: the client attaches to these pipes. `--interactive` is required; there is no port to publish.
CMD ["node", "dist/server.js"]

# Verify with:
#   docker build -t pro-fetch-mcp .
#   printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' \
#     | docker run -i --rm pro-fetch-mcp | head -c 400
# The expected shape of that answer: an initialize result, then a tools/list naming 761 tools.
