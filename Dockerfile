# Render container for the PrExplainer agent (wrangler.jsonc → containers).
#
# A Cloudflare Sandbox image: the sandbox control binary from the official image
# on top of a Node image that carries everything a HyperFrames render needs —
# Chromium, fonts, FFmpeg and the HyperFrames CLI — plus the HyperFrames skills
# where Flue discovers workspace skills (/workspace/.agents/skills). The agent
# never installs anything at run time.
#
# Keep the two pins in step: HYPERFRAMES_VERSION with the skills the agent was
# written against, and the sandbox image tag with the @cloudflare/sandbox
# package version in package.json.

FROM node:22-bookworm-slim

ARG HYPERFRAMES_VERSION=0.8.202
ARG SANDBOX_VERSION=0.12.14

# Chromium and the libraries it links, fonts for Latin/CJK/emoji text, FFmpeg.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip xz-utils git chromium ffmpeg \
    libgbm1 libnss3 libatk-bridge2.0-0 libdrm2 libxcomposite1 \
    libxdamage1 libxrandr2 libcups2 libasound2 libpangocairo-1.0-0 \
    libxshmfence1 libgtk-3-0 \
    fonts-liberation fonts-noto-color-emoji fonts-noto-cjk fonts-noto-core \
    fonts-noto-extra fonts-noto-ui-core fonts-freefont-ttf fonts-dejavu-core \
    fontconfig \
    && rm -rf /var/lib/apt/lists/* && apt-get clean && fc-cache -f

# The CLI, pinned; it is run as `hyperframes`, never through npx (no network at render time).
RUN npm install -g hyperframes@${HYPERFRAMES_VERSION} && npm cache clean --force

# chrome-headless-shell gives HyperFrames its deterministic BeginFrame capture
# path (the same frames in `check`, `snapshot` and `render`). Cloudflare
# containers are amd64, which chrome-for-testing ships.
RUN npx --yes @puppeteer/browsers install chrome-headless-shell@stable --path /opt/chrome \
    && ln -s "$(find /opt/chrome -name chrome-headless-shell -type f | head -1)" /usr/local/bin/chrome-headless-shell \
    && test -x /usr/local/bin/chrome-headless-shell

# The HyperFrames skills the CLI ships, placed where Flue discovers workspace
# skills for an agent whose cwd is /workspace.
RUN mkdir -p /workspace/.agents/skills \
    && cp -r "$(npm root -g)/hyperframes/dist/skills/hyperframes" \
             "$(npm root -g)/hyperframes/dist/skills/hyperframes-cli" \
             "$(npm root -g)/hyperframes/dist/skills/media-use" \
             /workspace/.agents/skills/

# Chromium: use the system build (no download), no sandbox inside the container.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PRODUCER_HEADLESS_SHELL_PATH=/usr/local/bin/chrome-headless-shell \
    CONTAINER=true \
    CI=true \
    # HyperFrames: no skill refreshes, update checks or telemetry from inside a render.
    HYPERFRAMES_SKIP_SKILLS=1 \
    HYPERFRAMES_NO_UPDATE_CHECK=1 \
    HYPERFRAMES_NO_TELEMETRY=1 \
    NODE_OPTIONS=--max-old-space-size=4096

# The Sandbox SDK control plane. Its version must match @cloudflare/sandbox in package.json.
COPY --from=docker.io/cloudflare/sandbox:0.12.14 /container-server/sandbox /sandbox

WORKDIR /workspace
ENTRYPOINT ["/sandbox"]
