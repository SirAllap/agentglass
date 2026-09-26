# The runner CI uses, as an image: ubuntu-latest is 24.04, whose apt tmux is
# 3.4 (built with libutempter) and python3 is 3.12. Bun comes in as a build
# argument that run.sh reads from ci.yml, so the pin lives in one place.
FROM ubuntu:24.04
ARG BUN_VERSION
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      tmux python3 git curl unzip ca-certificates bsdutils util-linux procps sqlite3 lsof psmisc sudo iproute2 gh \
    && rm -rf /var/lib/apt/lists/*
# The runner image has Node 20 on PATH; electron/build.mjs and mobile run under it.
RUN curl -fsSL https://nodejs.org/dist/v20.19.5/node-v20.19.5-linux-x64.tar.gz | tar -xz -C /usr/local --strip-components=1
# Non-root `runner` with passwordless sudo, like the hosted runner's job user.
RUN useradd -m -u 1001 -s /bin/bash runner && echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner
RUN su runner -c 'curl -fsSL https://bun.sh/install | bash -s "bun-v'"${BUN_VERSION:?}"'"'
# gh ships on the runner image; server/test/gh-lookup-retries.test.ts needs it on PATH.
# Without LANG tmux prints a format tab as `_`.
ENV LANG=C.UTF-8 CI=true GITHUB_ACTIONS=true
# ci.yml's smoke step uses setup-chrome (stable); the mobile suites find Chrome on PATH.
RUN curl --http1.1 --retry 3 -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends /tmp/chrome.deb \
    && rm -f /tmp/chrome.deb && rm -rf /var/lib/apt/lists/*
