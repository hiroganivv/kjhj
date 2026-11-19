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
      awscli openjdk-17-jre-headless \
      libreoffice-writer libreoffice-calc libreoffice-impress \
    && rm -rf /var/lib/apt/lists/*

# ---- Android tools (aapt/adb/apktool NOT in ubuntu 22.04 repos) -------------
# Official Android platform-tools provides adb + aapt2; aapt (legacy) comes
# from the platform-tools zip. apktool is a jar wrapped as a CLI.
RUN curl -fsSL "https://dl.google.com/android/repository/platform-tools-latest-linux.zip" -o /tmp/pt.zip \
    && unzip -q /tmp/pt.zip -d /opt \
    && ln -sf /opt/platform-tools/adb /usr/local/bin/adb \
    && ln -sf /opt/platform-tools/aapt2 /usr/local/bin/aapt \
    && rm -f /tmp/pt.zip
RUN JAR_URL=$(curl -fsSL https://api.github.com/repos/iBotPeaches/Apktool/releases/latest \
      | python3 -c 'import sys,json;print(next(a["browser_download_url"] for a in json.load(sys.stdin)["assets"] if a["name"].endswith(".jar")))') \
    && curl -fsSL "$JAR_URL" -o /opt/apktool.jar \
    && printf '#!/bin/sh\nexec java -jar /opt/apktool.jar "$@"\n' > /usr/local/bin/apktool \
    && chmod +x /usr/local/bin/apktool

# ---- global git config: HTTP/1.1 avoids CI HTTP/2 flakes for nested git deps
# (netexec's impacket/pynfsclient, msfconsole clone, etc.)
RUN git config --system http.version HTTP/1.1 \
    && git config --system http.postBuffer 524288000

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
    && SKIP_APT=1 GITHUB_TOKEN="${GITHUB_TOKEN}" bash install.sh \
    && echo "--- toolchain installed ---" \
    && command -v nmap nuclei sqlmap msfconsole jadx netexec || true

# Default: keep container alive; the Actions job overrides this with its steps.
CMD ["/bin/bash"]
