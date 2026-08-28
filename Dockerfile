FROM node:22.23.2-alpine3.23@sha256:46825fbbd4e996a78b7a2cdc08d75e38a5a505bdab95dcda55605359bf124bc6
WORKDIR /app
COPY --chown=root:root . .
RUN mkdir -p /app/data \
    && cp /app/data/fallback.json /app/fallback.json \
    && chown -R root:root /app \
    && chown -R node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=8787 NODE_ENV=production FALLBACK_FILE=/app/fallback.json
EXPOSE 8787
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server.js"]
