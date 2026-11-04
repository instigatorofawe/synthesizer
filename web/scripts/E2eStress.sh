#!/bin/sh
# Runs the e2e suite slowed, as a slower machine would run it, before a PR that changes the tests, the engine session, compiling or
# layout. A flake that needs a slow machine shows here, on the Mac, rather than on CI.
#
#   pnpm e2e:stress [playwright test arguments...]        from web/
#
# Each pass throttles the page's main thread (E2E_CPU) and holds each compile's answer 300 ms and each image 100 ms on its way to
# the engine (Fixtures.ts). It sweeps several rates rather than one heavy one: a test whose window falls across a recurring event
# fails only in a band of speeds, as flake 4 did at 3 to 5 times slower here and passed at 6 and 8. This Mac runs the suite about 3
# times as fast as CI's runner, so 4 is about CI's speed. E2E_STRESS_RATES sets the rates. No retries: a pass on a retry would hide
# what this is for.
set -u
status=0
for rate in ${E2E_STRESS_RATES:-2 3 4 5}; do
	echo "E2eStress: CPU $rate times slower, compiles 300 ms and loads 100 ms late"
	E2E_CPU=$rate E2E_COMPILE_DELAY=${E2E_COMPILE_DELAY:-300} E2E_LOAD_DELAY=${E2E_LOAD_DELAY:-100} \
		pnpm exec playwright test --retries=0 "$@" || status=1
done
exit "$status"
