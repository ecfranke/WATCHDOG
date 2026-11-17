FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
ENV DATA_FILE=/data/watchdog.json NODE_ENV=production
VOLUME /data
EXPOSE 8080
CMD ["node", "src/index.js"]
