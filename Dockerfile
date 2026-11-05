FROM node:22-slim

WORKDIR /app

# ffmpeg-static and @napi-rs/canvas ship prebuilt binaries — no build toolchain needed.
# fonts are used by the poster renderer.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 5000
CMD ["npm", "start"]
