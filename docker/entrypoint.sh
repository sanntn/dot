#!/bin/sh
set -e

DATA="${DOT_DATA_DIR:-/data/dot}"

# The executor commits in worktrees, and git refuses to commit without an identity.
setup_git_identity() {
  gosu node git config --global user.name "${DOT_GIT_NAME:-Dot}"
  gosu node git config --global user.email "${DOT_GIT_EMAIL:-dot@localhost}"
  # Agents copy the base branch out of Dot's own root-owned transport repository (server/src/git.ts).
  # git refuses to read a repository owned by someone else unless this says it may. It is the agent's
  # own config and only affects git run as the agent. The server's git ignores it.
  gosu node git config --global safe.directory '*'
}

mkdir -p /data/home "$DATA/repos" "$DATA/worktrees"

# DOT_AGENT_ISOLATION=off keeps the old setup: everything runs as the unprivileged node user.
if [ "${DOT_AGENT_ISOLATION:-on}" = "off" ]; then
  # Also undoes the lock-down of an earlier isolated start, which left the database owned by root.
  if [ "$(stat -c %U /data)" != "node" ] || [ "$(stat -c %U "$DATA")" != "node" ]; then
    chown -R node:node /data
  fi
  setup_git_identity
  exec gosu node "$@"
fi

# The server runs as root and the agents run as the unprivileged user node (server/src/isolation.ts).
# What the agents work in belongs to node. A volume from an older deploy is fixed once, not on every start.
for dir in /data/home "$DATA/repos" "$DATA/worktrees"; do
  if [ "$(stat -c %U "$dir")" != "node" ]; then
    chown -R node:node "$dir"
  fi
done
setup_git_identity

# What the server keeps to itself, readable only by root: the database, the session secret and the
# attachments. node may enter the data folder, to reach repos and worktrees, but not list or read it.
chown root:root "$DATA"
chmod 711 "$DATA"
for file in "$DATA"/dot.db "$DATA"/dot.db-wal "$DATA"/dot.db-shm "$DATA"/dot.db-journal "$DATA"/session.json; do
  if [ -e "$file" ]; then
    chown root:root "$file"
    chmod 600 "$file"
  fi
done
if [ -d "$DATA/attachments" ]; then
  chown -R root:root "$DATA/attachments"
  chmod 700 "$DATA/attachments"
fi

# npm runs as root here. Keep its cache out of the agents' home folder, where root-owned files
# would break the agents' own npm.
export npm_config_cache=/tmp/npm-cache-root

exec "$@"
