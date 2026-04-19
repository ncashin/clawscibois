FROM oven/bun:1

# Required tools: git for the workspace repo; util-linux for setpriv/su;
# curl for HEALTHCHECK and the opencode installer; ca-certificates for
# TLS validation; rsync for fast seed copies; tar because the opencode
# installer extracts a tarball.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      util-linux \
      curl \
      ca-certificates \
      rsync \
      tar \
    && rm -rf /var/lib/apt/lists/*

# Two users: app (runs processes), agent (runs opencode + its tools).
# oven/bun:1 ships with a pre-existing 'bun' user at uid/gid 1000; rename
# it to 'app' so we don't collide. Then add 'agent' at 1001 and put 'app'
# in the agent group for shared read access.
RUN groupadd -g 1001 agent \
 && useradd -u 1001 -g 1001 -M -s /usr/sbin/nologin agent \
 && groupmod -n app bun \
 && usermod -l app -d /home/app -m -s /bin/bash -G agent bun

# Install opencode via the official installer. The GHCR image
# (ghcr.io/anomalyco/opencode:latest) ships a musl-linked binary intended
# for alpine; copying it into a debian-based image fails with
# `libc.musl-*.so.1 => not found`. The installer picks the correct
# glibc-linked build for the current arch.
RUN curl -fsSL https://opencode.ai/install | \
    bash -s -- --no-modify-path \
 && cp /root/.opencode/bin/opencode /usr/local/bin/opencode \
 && chmod 755 /usr/local/bin/opencode \
 && rm -rf /root/.opencode

WORKDIR /opt/workspace-seed
COPY . .
RUN chmod +x /opt/workspace-seed/infra/entrypoint.sh

# Pre-install into the seed (so first-boot copy into the volume is fast).
RUN (cd src/website && bun install --frozen-lockfile --ignore-scripts) \
 && (cd src/discordbot && bun install --frozen-lockfile) \
 && (cd infra/supervisor && bun install --frozen-lockfile)

WORKDIR /workspace

# Expose only what external callers need. 4096 (opencode) is intentionally
# NOT exposed — it stays on 127.0.0.1 inside the container.
EXPOSE 3000 3001

ENV PORT=3000
ENV WORKSPACE=/workspace

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -sf http://127.0.0.1:3002/supervisor/health || exit 1

# Entrypoint starts as root to set perms; execs supervisor as user 'app'.
ENTRYPOINT ["/opt/workspace-seed/infra/entrypoint.sh"]
