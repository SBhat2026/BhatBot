FROM node:22-slim
WORKDIR /app
# build deps for better-sqlite3 native module (falls back to prebuilt when available)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
COPY notion.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
ENV PORT=8080
ENV DATA_DIR=/data
EXPOSE 8080
CMD ["node", "src/index.js"]
