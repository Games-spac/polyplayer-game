FROM node:22-slim
WORKDIR /app
COPY . .
CMD ["node", "server-2.js"] 