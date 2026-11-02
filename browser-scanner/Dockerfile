FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit
COPY *.mjs *.py ./
USER pwuser
EXPOSE 5180
CMD ["node", "server.mjs"]
