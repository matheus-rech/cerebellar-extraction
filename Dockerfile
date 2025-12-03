# Genkit Multi-Agent System - Cloud Run Deployment
# Exposes 41 Genkit flows including multi-agent critics, evaluators, and chat

FROM node:20-slim

WORKDIR /app

# Install curl for health check
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install all dependencies (need devDependencies for tsx)
RUN npm ci

# Copy source code and prompts
COPY src/ ./src/
COPY prompts/ ./prompts/
COPY tsconfig.json ./

# Expose Genkit server port
EXPOSE 3400

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3400

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3400/ || exit 1

# Start Genkit Express server using tsx (handles TypeScript directly)
CMD ["npx", "tsx", "src/genkit.ts", "serve", "3400", "--cors"]
