FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
# Import public roots with a tool compatible with this image's existing NSS.
# Pin the installed runtime explicitly; adding the tool must not upgrade it.
RUN runtime_nss="$(dpkg-query -W -f='${Version}' libnss3)" \
 && apt-get update \
 && apt-get install -y --no-install-recommends libnss3="$runtime_nss" libnss3-tools=2:3.98-1ubuntu0.3 \
 && test "$(dpkg-query -W -f='${Version}' libnss3)" = "$runtime_nss" \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit
COPY *.mjs *.py ./
USER pwuser
EXPOSE 5180
CMD ["node", "server.mjs"]
