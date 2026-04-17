FROM oven/bun:1-alpine

COPY --from=ghcr.io/anomalyco/opencode:latest /usr/local/bin/opencode /usr/local/bin/opencode

WORKDIR /opt/workspace-seed
COPY . .
RUN chmod +x /opt/workspace-seed/entrypoint.sh

RUN (cd website && bun install --frozen-lockfile --ignore-scripts)
RUN (cd discordbot && bun install --frozen-lockfile)

RUN mkdir -p /workspace \
  && cp /opt/workspace-seed/entrypoint.sh /workspace/entrypoint.sh \
  && chmod +x /workspace/entrypoint.sh
WORKDIR /workspace

EXPOSE 3000 3001 4096
ENV PORT=3000

ENTRYPOINT ["/workspace/entrypoint.sh"]
