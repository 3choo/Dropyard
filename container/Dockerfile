# dropyard extraction container: real unrar-grade RAR support via 7-Zip.
# Built by `wrangler deploy` from this directory (Docker must be running).

FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
  && rm -rf /var/lib/apt/lists/*

# Official 7-Zip for Linux (supports RAR3/RAR5 extraction, multi-volume sets).
RUN set -eux; \
  curl -fsSL --retry 4 -o /tmp/7z.tar.xz https://www.7-zip.org/a/7z2501-linux-x64.tar.xz; \
  mkdir -p /opt/7z; \
  tar -xJf /tmp/7z.tar.xz -C /opt/7z 7zz; \
  ln -s /opt/7z/7zz /usr/local/bin/7zz; \
  rm /tmp/7z.tar.xz; \
  7zz i | grep -q Rar

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY main.mjs ./

EXPOSE 8080
CMD ["node", "main.mjs"]
