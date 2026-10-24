FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com
COPY . .
USER node
EXPOSE 3000
CMD ["node", "server.js"]
