FROM node:20-alpine

# @napi-rs/canvas ships a musl binary so no build tools are needed,
# but at runtime it requires fontconfig + a font for text rendering.
RUN apk add --no-cache fontconfig ttf-dejavu

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

CMD ["node", "src/index.js"]
