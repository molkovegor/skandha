FROM oven/bun:1.2.23-debian AS build_src
WORKDIR /usr/app
RUN apt-get update && apt-get install -y build-essential python3 git && rm -rf /var/lib/apt/lists/*
COPY . .
RUN bun install --frozen-lockfile && \
    bun run build:all && \
    bun install --production
FROM oven/bun:1.2.23-debian AS build_deps
WORKDIR /usr/app
COPY --from=build_src /usr/app .

FROM oven/bun:1.2.23-debian
WORKDIR /usr/app
COPY --from=build_deps /usr/app .
ENTRYPOINT ["bun", "./packages/cli/bin/skandha"]