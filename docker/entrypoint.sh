#!/bin/sh
set -e

# Coolify mounts /data owned by root. Fix that once, then run as the unprivileged node user.
mkdir -p /data/home /data/dot
if [ "$(stat -c %U /data)" != "node" ]; then
  chown -R node:node /data
fi

# The executor commits in worktrees, and git refuses to commit without an identity.
gosu node git config --global user.name "${DOT_GIT_NAME:-Dot}"
gosu node git config --global user.email "${DOT_GIT_EMAIL:-dot@localhost}"

exec gosu node "$@"
