#!/bin/sh
# Builds tinyproxy's config from $ALLOW (space-separated domains) and runs it in the foreground.
set -eu

: > /tmp/allow
for domain in $ALLOW; do
  # archive.ubuntu.com -> (^|\.)archive\.ubuntu\.com$   i.e. the domain itself and its subdomains
  printf '(^|\.)%s$\n' "$(printf %s "$domain" | sed 's/\./\./g')" >> /tmp/allow
done

cat > /tmp/tinyproxy.conf <<CONF
Port 8888
Listen 0.0.0.0
Timeout 600
MaxClients 50
LogLevel Connect
# Allow-list mode: only hosts matching /tmp/allow get through; everything else gets 403 "Filtered".
Filter "/tmp/allow"
FilterType ere
FilterDefaultDeny Yes
FilterURLs Off
# HTTPS tunnels (CONNECT) only to port 443, so the proxy can't be used to reach arbitrary services.
ConnectPort 443
CONF

exec tinyproxy -d -c /tmp/tinyproxy.conf
