#!/bin/sh
# Runs the e2e suite with Chromium on Linux, as CI does, in Playwright's own image, with the app's server and the test runner on
# this machine. It gives a Mac what CI has that it hasn't: Linux's Chromium, its keys (Mod is Ctrl) and its audio's rate. The
# browser reaches the app through Playwright's tunnel, so the tests' addresses stay as they are.
#
#   pnpm e2e:linux [playwright test arguments...]        from web/, with Docker running
#
# The image's architecture is this machine's unless E2E_LINUX_ARCH says (arm64 or amd64; the other runs emulated, slowly). The
# browser's server takes E2E_PORT + 100, and its container is named after E2E_PORT, so two checkouts' runs don't meet.
set -eu
case "${E2E_LINUX_ARCH:-$(uname -m)}" in
arm64 | aarch64) platform=linux/arm64 ;;
x86_64 | amd64) platform=linux/amd64 ;;
*) echo "E2E_LINUX_ARCH is arm64 or amd64" >&2; exit 2 ;;
esac
version=$(node -p "require('@playwright/test/package.json').version")
image=mcr.microsoft.com/playwright:v$version-noble
port=$((${E2E_PORT:-5331} + 100))
name=modsynth-e2e-linux-${E2E_PORT:-5331}
# The browser's server is the same Playwright as the tests', reached through @playwright/test's own dependencies.
core=$(node -p "const { dirname } = require('path'), at = (name, from) => dirname(require.resolve(name + '/package.json', { paths: [from] }));
at('playwright-core', at('playwright', at('@playwright/test', process.cwd())))")
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --rm --name "$name" --platform "$platform" --init --ipc=host -p "127.0.0.1:$port:$port" -e TZ=UTC \
	-v "$core:/pw:ro" "$image" node /pw/cli.js run-server --port "$port" --host 0.0.0.0 >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT INT TERM
# The browser's server is up when its port answers. The image is pulled on the first run, which can take minutes.
tries=0
until curl -s -o /dev/null "http://127.0.0.1:$port/"; do
	tries=$((tries + 1))
	[ "$tries" -lt 3000 ] || { echo "the browser's server never answered" >&2; docker logs "$name" >&2; exit 1; }
	sleep 0.1
done
PW_TEST_CONNECT_WS_ENDPOINT="ws://127.0.0.1:$port/" PW_TEST_CONNECT_EXPOSE_NETWORK='<loopback>' pnpm exec playwright test "$@"
