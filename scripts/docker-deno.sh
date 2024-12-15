#!/usr/bin/env bash

docker run --rm -it \
  -v "$PWD/../":/app \
  -w /app \
  -e DENO_DIR=/app/.deno_dir \
  --user "$(id -u):$(id -g)" \
  denoland/deno:2.1.2 \
  sh -c "deno task $*"
