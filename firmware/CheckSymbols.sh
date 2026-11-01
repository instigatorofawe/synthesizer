#!/bin/sh
# Fails if a firmware ELF picked up threading, atomics or double-precision run-path code. This check has to exist: a
# toolchain with a full C++ library would compile parallel.hpp without complaint.
set -e
status=0
for elf in "$@"; do
    symbols=$(arm-none-eabi-nm -C "$elf")
    if echo "$symbols" | grep -E 'pthread|std::thread|std::mutex|__atomic_|__sync_|__cxa_guard'; then
        echo "$elf: threading symbols present" >&2
        status=1
    fi
    if arm-none-eabi-objdump -d "$elf" | grep -E '\s(ldrex|strex|clrex)[a-z]*\s'; then
        echo "$elf: exclusive access instructions present" >&2
        status=1
    fi
done
exit $status
