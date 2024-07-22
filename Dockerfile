FROM node:lts-alpine AS build
WORKDIR /app
COPY . .
RUN npm i
RUN npm run build

FROM node:lts-alpine AS runtime
WORKDIR /app
COPY --from=build /app/dist /app
CMD ["node", "./index.js"]
EXPOSE 3000
