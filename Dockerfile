FROM node:22-alpine
WORKDIR /app
COPY . .
RUN chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=8787 NODE_ENV=production
EXPOSE 8787
CMD ["node","server.js"]
