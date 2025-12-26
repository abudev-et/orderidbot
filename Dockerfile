# Telegram Bot Dockerfile for Back4App Containers
# Base image: Node.js 18 on Alpine Linux (lightweight)
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application source code
COPY . .

# Create data directory for user uploads
RUN mkdir -p /app/data

# Set environment variables for production
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=512"

# Telegram bots don't need to expose ports (they use polling)
# But we can expose a health check port if needed
# EXPOSE 3000

# Start the bot
CMD ["node", "bot.js"]
