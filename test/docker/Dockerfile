# The colleague's machine: fresh Linux user, no prior Claude Code state.
FROM node:22-slim
ARG CLAUDE_VERSION=latest
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates >/dev/null \
 && npm install -g --silent @anthropic-ai/claude-code@${CLAUDE_VERSION} && rm -rf /var/lib/apt/lists/*
USER node
WORKDIR /home/node
ENV DISABLE_AUTOUPDATER=1
