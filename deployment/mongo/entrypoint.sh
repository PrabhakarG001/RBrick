#!/bin/bash
set -euo pipefail
# Docker secrets mounts may have permissive host modes. Copy to the persistent
# config volume with MongoDB-required owner/mode; never echo key material.
install -o mongodb -g mongodb -m 400 /run/secrets/mongo_keyfile /data/configdb/resilliox-keyfile
exec /usr/local/bin/docker-entrypoint.sh mongod --replSet rs0 --bind_ip_all --keyFile /data/configdb/resilliox-keyfile
