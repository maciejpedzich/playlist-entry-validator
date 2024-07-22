FROM node:lts-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build

FROM node:lts-alpine AS runtime
WORKDIR /app
ENV NODE_ENV production
USER node
COPY --chown=node:node package*.json ./
RUN npm ci --production
COPY --from=builder --chown=node:node /app/dist ./dist
EXPOSE 3000
CMD ["node", "./dist/index.js"]
