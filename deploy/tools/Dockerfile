# Pre-baked toolchain image for the Pojun deploy runner.
#
# Rationale: GitHub-hosted runners are ephemeral. Installing 90 pentest tools
# on every rotation took 5-15 min and left a long service gap, and git-based
# tools (netexec/msfconsole) failed intermittently due to HTTP/2 flakes.
# Baking them into an image once makes every rotation start with all tools
# already on PATH -> /api/hostenv/status reports 90/90, no per-run install.
#
# The tool inventory + recipes come from deploy/tools/tool-catalog.json, which
# is extracted from Pojun's canonical hosttools.catalog. install.py reproduces
# hostenv's detection exactly.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai

# ---- system deps -----------------------------------------------------------
# sudo kept so install.py's recipes work unchanged; in the image we are root
# so install.py auto-detects SUDO=[] and calls commands directly.
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      ca-certificates curl wget git unzip zip gzip xz-utils \
      sudo python3 python3-pip python3-venv python3-dev \
      build-essential pkg-config libffi-dev libssl-dev \
      postgresql-client openssl nginx net-tools iputils-ping dnsutils \
      imagemagick poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip first: ubuntu 22.04 ships pip 22.0 which does NOT understand
# --break-system-packages (the flag only exists in pip >= 23). install.py uses
# that flag for the tool recipes, so get a modern pip in place first.
RUN python3 -m pip install --no-cache-dir -U pip setuptools wheel

# ---- Node 22 (build static UI each run) ------------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y -qq --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node -v && npm -v

# ---- Go 1.26.3 (build app binary each run; matches Pojun go.mod) -----------
ARG GO_VERSION=1.26.3
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o /tmp/go.tgz \
    && tar -C /usr/local -xzf /tmp/go.tgz \
    && rm -f /tmp/go.tgz
ENV PATH="/usr/local/go/bin:${PATH}"
RUN go version

# ---- frpc (tunnel client) --------------------------------------------------
ARG FRP_VERSION=v0.62.0
RUN curl -fsSL "https://github.com/fatedier/frp/releases/download/${FRP_VERSION}/frp_${FRP_VERSION#v}_linux_amd64.tar.gz" -o /tmp/frp.tgz \
    && tar -xzf /tmp/frp.tgz -C /tmp \
    && install -m 0755 "/tmp/frp_${FRP_VERSION#v}_linux_amd64/frpc" /usr/local/bin/frpc \
    && rm -rf /tmp/frp.tgz "/tmp/frp_${FRP_VERSION#v}_linux_amd64" \
    && frpc -v

# ---- the 90 host tools -----------------------------------------------------
COPY deploy/tools/ /opt/toolchain/
# Build-time: root, no sudo -> install.py uses SUDO=[]. GITHUB_TOKEN optional
# (raises GitHub API rate limit for git-based tools during build); inject via
# --build-arg if available.
ARG GITHUB_TOKEN=""
ENV GITHUB_TOKEN=${GITHUB_TOKEN}
RUN cd /opt/toolchain \
    && GITHUB_TOKEN="${GITHUB_TOKEN}" bash install.sh \
    && echo "--- toolchain installed ---" \
    && command -v nmap nuclei sqlmap msfconsole jadx netexec || true

# Default: keep container alive; the Actions job overrides this with its steps.
CMD ["/bin/bash"]
