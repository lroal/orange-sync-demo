FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends nginx libnginx-mod-http-brotli-filter libnginx-mod-http-brotli-static ca-certificates \
  && rm -rf /var/lib/apt/lists/*

CMD ["nginx", "-g", "daemon off;"]
