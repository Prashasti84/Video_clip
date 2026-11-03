# Video Clip server — Node + ffmpeg + yt-dlp in one image (Railway / Render / Fly.io / any Docker host).
# Mount a persistent volume at /app/temp so jobs, uploads, clips and the transcript cache survive redeploys.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx tsc

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && curl -fsSL -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
 && chmod +x /usr/local/bin/yt-dlp \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
# yt-dlp needs a JavaScript runtime for YouTube — use the image's Node instead of installing Deno.
RUN echo "--js-runtimes node" > /etc/yt-dlp.conf

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY dashboard.html ./

EXPOSE 3737
CMD ["node", "dist/server.js"]
