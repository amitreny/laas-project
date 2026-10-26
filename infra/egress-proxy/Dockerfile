# The egress proxy sidecar: the only way out of a lab's network, and only to allow-listed domains.
FROM alpine:3.22
RUN apk add --no-cache tinyproxy
COPY entrypoint.sh /entrypoint.sh
# No root needed: it listens on an unprivileged port and only writes to /tmp.
USER nobody
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
