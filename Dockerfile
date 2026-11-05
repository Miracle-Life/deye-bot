FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production TZ=Europe/Kyiv
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY assets ./assets
RUN mkdir -p /app/data && chown node:node /app/data
USER node
# --expose-gc: see src/render/png.ts (native memory of PNG renders)
CMD ["node", "--expose-gc", "dist/main.js"]
