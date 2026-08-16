FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
ENV RELAY_PORT=4020
ENV RELAY_STATE=/data/cloud-relay.json
EXPOSE 4020
CMD ["node", "src/server.mjs"]
