#!/bin/bash
# Inside the container. PID 1 stays root, as systemd does on the runner, so
# "another user's process" exists; the steps run as `runner` with the runner's
# environment (no TERM) in a real git checkout at the runner's path.
mkdir -p /home/runner/work/agentglass && chown runner /home/runner/work/agentglass
dest=/home/runner/work/agentglass/agentglass
mkdir "$dest" && tar -x -C "$dest" && chown -R runner "$dest" || exit 2
# bun test runs files in directory order. The runner's ext4 gives a hashed
# order; the tar stream arrives sorted and this machine's filesystem keeps
# creation order, so here every run was alphabetical and a test that leaked
# into one that came later only on the runner passed here. Each test file is
# re-created in a shuffled order instead; the seed is printed so a red replays.
seed="${AGX_CI_SEED:-$RANDOM}"
echo "test file order: seed $seed (AGX_CI_SEED=$seed to replay)"
(cd "$dest" && find . -name node_modules -prune -o -name '*.test.ts*' -type f -print \
  | sort | shuf --random-source=<(yes "$seed") | while read -r f; do mv "$f" "$f.o" && mv "$f.o" "$f"; done)
sleep infinity &
exec_as() { setpriv --reuid=1001 --regid=1001 --init-groups env -i HOME=/home/runner USER=runner LOGNAME=runner SHELL=/bin/bash \
  PATH=/home/runner/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 CI=true GITHUB_ACTIONS=true "$@"; }
exec_as bash -c "cd $dest && git init -q && git add -A >/dev/null && git -c user.name=ci -c user.email=ci@example.invalid commit -qm tree" || exit 2
exec_as bash -c "cd $dest && bash scripts/ci-docker/steps.sh"
