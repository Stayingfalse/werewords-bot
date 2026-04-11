FROM node:20-alpine

# @napi-rs/canvas ships a musl binary so no build tools are needed,
# but at runtime it requires fontconfig + a font for text rendering.
# build-base + python3 are a fallback for better-sqlite3 if its prebuilt
# linux-arm64-musl binary is unavailable and it must compile from source.
RUN apk add --no-cache fontconfig ttf-dejavu build-base python3

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

CMD ["node", "src/index.js"]
