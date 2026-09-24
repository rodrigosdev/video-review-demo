# The container a PR review runs in: Cloudflare's sandbox base image (Ubuntu 22.04,
# Node 22, git, and the control server on port 3000) plus headless Chromium and
# the recorder (which brings a static ffmpeg). Keep the tag in sync with
# @cloudflare/sandbox in package.json; they are versioned together. Keep the
# image small: Cloudflare pulls it onto each container host.
FROM docker.io/cloudflare/sandbox:0.12.10

ENV CI=true \
    NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Corepack provides whichever pnpm/yarn version a repo pins in packageManager.
RUN npm install -g corepack@0.36.0 && corepack enable

COPY recorder/package.json /opt/recorder/package.json
RUN cd /opt/recorder \
    && npm install --omit=dev --no-audit --no-fund \
    && npx playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache
COPY recorder/record.mjs /opt/recorder/record.mjs
