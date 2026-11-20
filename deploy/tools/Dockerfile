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
# ubuntu 24.04 (noble): Python 3.12 — required by netexec (>=3.11).
# ubuntu 22.04 ships Python 3.10 which made netexec's wheel build fail with
# "requires a different Python 3.10 not in <4.0,>=3.11" on every attempt.
FROM ubuntu:24.04

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
      openssh-client jq \
    && rm -rf /var/lib/apt/lists/*

# ---- GitHub CLI (gh) -------------------------------------------------------
# Required by the deploy job's "Queue successor run" step. Without it the
# successor chain silently breaks and the watchdog keeps cancelling the
# serving run -> unsaved DB snapshots lost. Install from GitHub's official apt
# repo (not in ubuntu main).
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update -qq && apt-get install -y -qq --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && gh --version | head -1

# ---- hostenv apt tools (dedicated layer, no per-step script timeout) -------
# Install apt-based tools in the Dockerfile itself, NOT via install.py: the
# script's single 1800s subprocess timeout choked on libreoffice/openjdk when
# all 20+ packages were installed in one process. Splitting into small batches
# here keeps each apt transaction bounded and layers are cached across rebuilds.
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      nmap masscan sqlmap ffuf gobuster whatweb testssl.sh \
      hydra john hashcat socat proxychains4 sshuttle tcpdump netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      openjdk-17-jre-headless \
      libreoffice-writer libreoffice-calc libreoffice-impress \
    && rm -rf /var/lib/apt/lists/*

# awscli: apt name is unstable across Ubuntu releases -> install via pip
RUN python3 -m pip install --no-cache-dir --break-system-packages awscli || true

# ---- Android tools (adb from platform-tools, apktool from jar) --------------
RUN curl -fsSL "https://dl.google.com/android/repository/platform-tools-latest-linux.zip" -o /tmp/pt.zip \
    && unzip -q /tmp/pt.zip -d /opt \
    && ln -sf /opt/platform-tools/adb /usr/local/bin/adb \
    && rm -f /tmp/pt.zip
# aapt: try apt (noble universe); if absent, download aapt2 from Android
# build-tools as a compatible fallback so hostenv PATH check passes.
RUN (apt-get update -qq && apt-get install -y -qq --no-install-recommends aapt) \
      || curl -fsSL "https://dl.google.com/android/repository/build-tools_r35-linux.zip" -o /tmp/bt.zip \
      || true
RUN if ! command -v aapt >/dev/null 2>&1 && [ -f /tmp/bt.zip ]; then \
      unzip -q /tmp/bt.zip -d /opt/build-tools \
      && AAPT2=$(find /opt/build-tools -name aapt2 -type f | head -1) \
      && [ -n "$AAPT2" ] && ln -sf "$AAPT2" /usr/local/bin/aapt; \
    fi; rm -f /tmp/bt.zip; rm -rf /var/lib/apt/lists/*
# Pin a known jar URL: anonymous api.github.com is rate-limited during builds
# (install.py passes GITHUB_TOKEN, this layer does not).
RUN curl -fsSL "https://github.com/iBotPeaches/Apktool/releases/download/v3.0.3/apktool_3.0.3.jar" -o /opt/apktool.jar \
    && printf '#!/bin/sh\nexec java -jar /opt/apktool.jar "$@"\n' > /usr/local/bin/apktool \
    && chmod +x /usr/local/bin/apktool

# ---- global git config: HTTP/1.1 avoids CI HTTP/2 flakes for nested git deps
# (netexec's impacket/pynfsclient, msfconsole clone, etc.)
RUN git config --system http.version HTTP/1.1 \
    && git config --system http.postBuffer 524288000

# ubuntu 24.04 ships pip 24.0 which already supports --break-system-packages
# (used by install.py). No pip upgrade needed - and Debian's pip can't be
# uninstalled via pip anyway ("RECORD file not found").

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
    && SKIP_APT=1 GITHUB_TOKEN="${GITHUB_TOKEN}" bash install.sh \
    && echo "--- toolchain installed ---" \
    && command -v nmap nuclei sqlmap msfconsole jadx netexec || true

# Default: keep container alive; the Actions job overrides this with its steps.
CMD ["/bin/bash"]
