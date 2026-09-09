FROM oven/bun:1.3.13 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/cli/package.json apps/cli/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/agents/package.json packages/agents/package.json
RUN bun install --frozen-lockfile
COPY packages packages
COPY apps/server apps/server
RUN bun build --compile apps/server/src/index.ts --outfile /app/pacifico-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/pacifico-server /usr/local/bin/pacifico-server
USER 10001:10001
EXPOSE 8787
ENTRYPOINT ["pacifico-server"]
