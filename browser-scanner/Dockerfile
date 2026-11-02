FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
# Import public roots with a tool compatible with this image's existing NSS.
# Pin the installed runtime explicitly; adding the tool must not upgrade it.
RUN runtime_nss="$(dpkg-query -W -f='${Version}' libnss3)" \
 && test "$runtime_nss" = '2:3.98-1ubuntu0.2' \
 && printf '%s\n' 'Types: deb' 'URIs: https://archive.ubuntu.com/ubuntu' \
      'Suites: noble noble-updates noble-security' 'Components: main' \
      'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg' \
      'Snapshot: 20261031T000000Z' > /tmp/remedy-nss.sources \
 && apt-get -o Dir::Etc::sourcelist=/tmp/remedy-nss.sources -o Dir::Etc::sourceparts=- update \
 && apt-get -o Dir::Etc::sourcelist=/tmp/remedy-nss.sources -o Dir::Etc::sourceparts=- \
      install -y --no-install-recommends libnss3="$runtime_nss" libnss3-tools=2:3.98-1ubuntu0.3 \
 && test "$(dpkg-query -W -f='${Version}' libnss3)" = "$runtime_nss" \
 && echo '505b13e3087e1abcabec3f1485e0e76b81322667dcae25758341b46bcfc5b62d  /usr/bin/certutil' | sha256sum -c - \
 && rm /tmp/remedy-nss.sources \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit
COPY *.mjs *.py ./
USER pwuser
EXPOSE 5180
CMD ["node", "server.mjs"]
