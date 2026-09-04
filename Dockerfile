# syntax = docker/dockerfile:1

ARG NODE_VERSION=22.22.2
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="Next.js"

WORKDIR /app

ENV NODE_ENV="production"

ARG PNPM_VERSION=11.18.0
RUN npm install -g pnpm@$PNPM_VERSION

# Build stage
FROM base AS build

RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp pkg-config python-is-python3

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false --config.dangerously-allow-all-builds=true

COPY . .

RUN npx next build


# Final stage
FROM base

COPY --from=build /app /app

EXPOSE 3000
CMD [ "pnpm", "run", "start" ]
