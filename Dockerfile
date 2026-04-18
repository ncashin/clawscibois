FROM oven/bun:1-alpine

COPY --from=ghcr.io/anomalyco/opencode:latest /usr/local/bin/opencode /usr/local/bin/opencode

WORKDIR /opt/workspace-seed
COPY . .
RUN chmod +x /opt/workspace-seed/entrypoint.sh

RUN (cd website && bun install --frozen-lockfile --ignore-scripts)
RUN (cd discordbot && bun install --frozen-lockfile)

WORKDIR /workspace

EXPOSE 3000 3001 4096
ENV PORT=3000
ENV WORKSPACE=/workspace

ENTRYPOINT ["/opt/workspace-seed/entrypoint.sh"]
