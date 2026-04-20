FROM oven/bun:1

# git: workspace repo. util-linux: setpriv/su. curl + ca-certificates:
# HEALTHCHECK + opencode installer (needs TLS). rsync + tar: seed copy
# and installer extraction.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      util-linux \
      curl \
      ca-certificates \
      rsync \
      tar \
    && rm -rf /var/lib/apt/lists/*

# Rename the pre-existing `bun` user (uid 1000) to `app` instead of adding
# a new one to avoid uid collision. `agent` is added fresh at 1001;
# `app` joins the agent group for shared read access on /workspace/src.
RUN groupadd -g 1001 agent \
 && useradd -u 1001 -g 1001 -M -s /usr/sbin/nologin agent \
 && groupmod -n app bun \
 && usermod -l app -d /home/app -m -s /bin/bash -G agent bun

# Official opencode installer. The ghcr.io/anomalyco/opencode image ships
# a musl binary for alpine, which fails on debian with
# `libc.musl-*.so.1 => not found`. The installer fetches the right glibc
# build for the current arch.
RUN curl -fsSL https://opencode.ai/install | \
    bash -s -- --no-modify-path \
 && cp /root/.opencode/bin/opencode /usr/local/bin/opencode \
 && chmod 755 /usr/local/bin/opencode \
 && rm -rf /root/.opencode

WORKDIR /opt/workspace-seed
COPY . .
RUN chmod +x /opt/workspace-seed/infra/entrypoint.sh

# Pre-install so the first-boot copy into the volume is fast.
RUN (cd src/website && bun install --frozen-lockfile --ignore-scripts) \
 && (cd src/discordbot && bun install --frozen-lockfile) \
 && (cd infra/supervisor && bun install --frozen-lockfile)

WORKDIR /workspace

# :4096 is exposed for reverse-proxy routing. The supervisor refuses to
# start opencode without OPENCODE_SERVER_PASSWORD, so an unsecured port
# is never actually served.
EXPOSE 3000 3001 4096

ENV PORT=3000
ENV WORKSPACE=/workspace

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -sf http://127.0.0.1:3002/supervisor/health || exit 1

# Entrypoint starts as root for setup, then execs the supervisor as `app`.
ENTRYPOINT ["/opt/workspace-seed/infra/entrypoint.sh"]
