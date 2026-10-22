# A custom lab image: bake in the tools the lab needs so sessions start instantly
# (installing packages in `setup` would happen on every single session start).
FROM ubuntu:24.04
RUN apt-get update \
 && apt-get install -y --no-install-recommends nginx curl less nano \
 && rm -rf /var/lib/apt/lists/*
