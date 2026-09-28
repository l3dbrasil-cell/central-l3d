FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json index.html app.js ./
COPY --chown=node:node server ./server
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
CMD ["node", "server/main.js"]
