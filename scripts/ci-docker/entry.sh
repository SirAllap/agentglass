#!/bin/bash
# Inside the container. PID 1 stays root, as systemd does on the runner, so
# "another user's process" exists; the steps run as `runner` with the runner's
# environment (no TERM) in a real git checkout at the runner's path.
mkdir -p /home/runner/work/agentglass && chown runner /home/runner/work/agentglass
dest=/home/runner/work/agentglass/agentglass
mkdir "$dest" && tar -x -C "$dest" && chown -R runner "$dest" || exit 2
sleep infinity &
exec_as() { setpriv --reuid=1001 --regid=1001 --init-groups env -i HOME=/home/runner USER=runner LOGNAME=runner SHELL=/bin/bash \
  PATH=/home/runner/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 CI=true GITHUB_ACTIONS=true "$@"; }
exec_as bash -c "cd $dest && git init -q && git add -A >/dev/null && git -c user.name=ci -c user.email=ci@example.invalid commit -qm tree" || exit 2
exec_as bash -c "cd $dest && bash scripts/ci-docker/steps.sh"
