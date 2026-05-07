# Multi-arch: works on Raspberry Pi 5 (arm64) and x86_64
FROM node:20-alpine

LABEL maintainer="Gianfranco"
LABEL description="Woot Deal Alert Bot — Real-time deal monitoring"

WORKDIR /app

# Copy application files
COPY package.json ./
COPY server.js app.js style.css sw.js ./
COPY index.html login.html ntfy-logs.html ./
COPY manifest.json ./

# Create data directory for persistent config
RUN mkdir -p /app/logs /app/data

# Expose the web server port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/login || exit 1

# Run as non-root for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

CMD ["node", "server.js"]
