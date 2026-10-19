# hourglass test environment
# Stages:
#   tools  — system deps + competitor sandboxes (nsjail 3.6, Codex 0.162.1, SRT v0.0.79)
#   dsh    — DeepSeek Harness at a pinned commit, installed and built
#   test   — hourglass packages fused into the DSH workspace + compare framework
#
# Build context: the hourglass repo root. GitHub sources are vendored under
# docker/vendor/ (host-side downloads are stable here; in-container GitHub
# access is not). Pinned versions also live in scripts/sandbox-compare/versions.lock.json.

ARG BASE=node:24-slim
FROM ${BASE} AS tools

ARG SRT_VERSION=0.0.79

# The host's static proxy (injected as 127.0.0.1:10808) is unreachable inside
# the container; repoint it at the host itself for the build stages only.
ENV http_proxy=http://host.docker.internal:10808 \
    https_proxy=http://host.docker.internal:10808 \
    no_proxy=localhost,127.0.0.1,host.docker.internal

# Debian mirror for faster apt on this host.
RUN sed -i 's|deb.debian.org|mirrors.ustc.edu.cn|g' /etc/apt/sources.list.d/debian.sources

# System dependencies: bubblewrap (DSH bwrap backend), toolchain for nsjail and
# DSH native/system (landlock launcher uses musl), plus basic utilities.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bubblewrap \
      git \
      curl \
      ripgrep \
      socat \
      ca-certificates \
      xz-utils \
      python3 \
      build-essential \
      pkg-config \
      clang \
      flex \
      bison \
      libprotobuf-dev \
      protobuf-compiler \
      libnl-3-dev \
      libnl-genl-3-dev \
      libnl-route-3-dev \
      musl-tools \
      procps \
      iproute2 \
      sudo \
      less \
      vim-tiny \
    && rm -rf /var/lib/apt/lists/*

# nsjail 3.6 from the vendored tarball. kafel is pre-seeded so nsjail's
# kafel_init target (which shells out to git submodule) is a no-op.
COPY docker/vendor/nsjail-3.6.tar.gz docker/vendor/kafel-master.tar.gz /tmp/vendor/
RUN mkdir /tmp/nsjail \
    && tar -xzf /tmp/vendor/nsjail-3.6.tar.gz -C /tmp/nsjail --strip-components=1 \
    && tar -xzf /tmp/vendor/kafel-master.tar.gz -C /tmp/nsjail/kafel --strip-components=1 \
    && cd /tmp/nsjail \
    && make -j"$(nproc)" \
    && install -m 0755 nsjail /usr/local/bin/nsjail \
    && rm -rf /tmp/nsjail /tmp/vendor

# OpenAI Codex CLI at a pinned release (official prebuilt binary, vendored;
# the tarball is a single bare executable).
COPY docker/vendor/codex-0.162.1.tar.gz /tmp/vendor/codex.tar.gz
RUN tar -xzf /tmp/vendor/codex.tar.gz -C /tmp \
    && install -m 0755 /tmp/codex-x86_64-unknown-linux-musl /usr/local/bin/codex \
    && rm -rf /tmp/vendor /tmp/codex-x86_64-unknown-linux-musl \
    && codex --version

# Anthropic Sandbox Runtime at a pinned npm version.
RUN npm install -g --omit=dev @anthropic-ai/sandbox-runtime@${SRT_VERSION}

# Wasmer at a pinned release (vendored; the tarball carries bin/ + lib/ and
# installs cleanly into /usr/local). v7.3.0 is the newest release whose
# binaries still satisfy bookworm's glibc 2.36 / GLIBCXX 3.4.30 (v7.4+ are
# built on ubuntu-24.04 and require GLIBC 2.38+). The WASMER compare lane
# runs WASI preview1 probe fixtures through it.
COPY docker/vendor/wasmer-v7.3.0-linux-amd64.tar.gz /tmp/vendor/wasmer.tar.gz
RUN mkdir -p /tmp/wasmer-dist \
    && tar -xzf /tmp/vendor/wasmer.tar.gz -C /tmp/wasmer-dist \
    && cp -a /tmp/wasmer-dist/bin/. /usr/local/bin/ \
    && cp -a /tmp/wasmer-dist/lib/. /usr/local/lib/ \
    && ldconfig \
    && rm -rf /tmp/wasmer-dist /tmp/vendor \
    && wasmer --version

# Zig toolchain (vendored) compiles the WASI probe fixture for the WASMER
# lane, then is removed — the compiled .wasm ships in the image.
COPY docker/vendor/zig-0.13.0.tar.xz /tmp/vendor/zig.tar.xz
COPY scripts/sandbox-compare/fixtures-wasm/ /opt/hourglass-src/fixtures-wasm/
RUN tar -xJf /tmp/vendor/zig.tar.xz -C /opt \
    && cd /opt/hourglass-src/fixtures-wasm \
    && /opt/zig-linux-x86_64-0.13.0/zig build-exe fs_probe.zig -target wasm32-wasi -O ReleaseSmall \
    && mkdir -p /opt/hourglass-wasm \
    && install -m 0644 fs_probe.wasm /opt/hourglass-wasm/fs_probe.wasm \
    && rm -rf /opt/zig-linux-x86_64-0.13.0 /tmp/vendor \
    && ls -la /opt/hourglass-wasm

FROM tools AS dsh

ENV DSH_TELEMETRY_DISABLED=1

# DSH at the pinned commit from the vendored tarball. The tree is not a git
# clone, but DSH's build asks `git rev-parse HEAD`, so materialize a local
# git history; the tag records the upstream commit the tarball came from.
COPY docker/vendor/dsh-d743267.tar.gz /tmp/vendor/dsh.tar.gz
RUN mkdir -p /opt/dsh \
    && tar -xzf /tmp/vendor/dsh.tar.gz -C /opt/dsh --strip-components=1 \
    && cd /opt/dsh \
    && git init -q \
    && git config user.email hourglass@local.invalid \
    && git config user.name hourglass \
    && git add -A \
    && git commit -qm "vendored from codeload d743267388641bc76f17c45ce8b4c231aed1d32c" \
    && git tag d743267388641bc76f17c45ce8b4c231aed1d32c \
    && rm -rf /tmp/vendor

# pnpm exactly as DSH's packageManager pins it (through the host proxy).
RUN corepack enable && corepack prepare pnpm@11.28.5 --activate \
    && cd /opt/dsh \
    && pnpm install --frozen-lockfile

# Native launcher (landlock-run) + full workspace build.
RUN cd /opt/dsh \
    && pnpm run build:native-system \
    && pnpm run build

FROM dsh AS test

# Fuse the hourglass packages into the DSH workspace (packages/*/* glob picks
# them up), then refresh the install to link them. The compare drivers live
# inside the workspace so their imports resolve against /opt/dsh/node_modules.
COPY packages/ /opt/dsh/packages/hourglass/
COPY scripts/sandbox-compare/driver/ /opt/dsh/packages/hourglass/driver/
COPY scripts/sandbox-compare/lifecycle/ /opt/dsh/packages/hourglass/lifecycle/
COPY scripts/sandbox-compare/manifest-from-compare.ts /opt/dsh/packages/hourglass/manifest-from-compare.ts
COPY scripts/sandbox-compare/ /opt/hourglass/scripts/sandbox-compare/
# Evolution v2 additions (feat/evolution-v2): the trial driver is copied into
# the fused workspace so its @hourglass/@deepseek-ai imports resolve; the
# runner scripts stay under /opt/hourglass/scripts like the compare framework.
COPY scripts/sandbox-evolution/driver/ /opt/dsh/packages/hourglass/evolution-driver/
COPY scripts/sandbox-evolution/ /opt/hourglass/scripts/sandbox-evolution/
COPY docker/entrypoint.sh /usr/local/bin/hourglass-entrypoint
RUN chmod +x /usr/local/bin/hourglass-entrypoint

# Adding packages to the workspace moves the lockfile; relink. Direct
# connection to the mirror registry (no proxy): the host proxy has proven
# flaky for registry traffic from this layer.
RUN cd /opt/dsh \
    && env http_proxy= https_proxy= HTTP_PROXY= HTTPS_PROXY= \
       pnpm install --no-frozen-lockfile --registry=https://registry.npmmirror.com

# Runtime: no proxy — compare cases must reach the local test service without
# one, and NET-03 explicitly strips proxy variables.
ENV http_proxy= https_proxy= no_proxy=

WORKDIR /opt/dsh
ENTRYPOINT ["/usr/local/bin/hourglass-entrypoint"]
CMD ["bash"]
