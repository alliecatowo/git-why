# Deliberately small execution image for agent trials.  Build it from the
# repository root so the packed product, rather than the evaluator checkout,
# is what enters the image:
#   docker build -f bench/agents/Dockerfile -t git-why-bench:local .
#
# The runner must still supply model credentials through a local allowlisted
# proxy; never bake auth.json or API keys into this image.
FROM node:22-bookworm-slim
ARG OPENCODE_VERSION=1.18.30
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "opencode-ai@${OPENCODE_VERSION}" "@zvec/zvec-grep@0.2.2"
WORKDIR /opt/git-why
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY scripts ./scripts
COPY schema ./schema
COPY README.md LICENSE NOTICE ./
RUN npm run build && npm pack --pack-destination /tmp && npm install --global /tmp/*.tgz
RUN useradd --create-home --uid 10001 bench
USER bench
WORKDIR /workspace
ENV HOME=/home/bench XDG_CONFIG_HOME=/home/bench/.config XDG_DATA_HOME=/home/bench/.local/share
ENTRYPOINT ["opencode"]
