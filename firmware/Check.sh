#!/bin/sh
# Builds the firmware, runs it on QEMU's L475, and compares its audio with the golden renders. Then fuzzes on a Cortex-M4.
# Expects the arm toolchain and QEMU on PATH. FUZZ_SECONDS and FUZZ_RANDOM choose how long, and from what seed.
set -e
cd "$(dirname "$0")/.."

cmake -S firmware -B build/firmware -G Ninja --toolchain "$PWD/firmware/ArmNoneEabi.cmake" -DCMAKE_BUILD_TYPE=Release \
    -DMODSYNTH_FUZZ_SECONDS="${FUZZ_SECONDS:-60}" -DMODSYNTH_FUZZ_RANDOM="${FUZZ_RANDOM:-1}"
cmake --build build/firmware

firmware/CheckSymbols.sh build/firmware/Stereo.elf build/firmware/Mono.elf build/firmware/StereoCmsis.elf \
    build/firmware/Stereo128.elf build/firmware/Mono128.elf build/firmware/StereoCmsis128.elf build/firmware/Nucleo.elf \
    build/firmware/NucleoCmsis.elf

cd build/firmware
for name in Stereo Mono StereoCmsis Stereo128 Mono128 StereoCmsis128; do
    echo "== $name"
    timeout 120 qemu-system-arm -machine b-l475e-iot01a -cpu cortex-m4 -nographic -monitor none -serial null \
        -semihosting-config enable=on,target=native -kernel "$name.elf" 2>&1
done
cd ../..

for image in Demo AllOps Waves Tones; do
    python3 tools/CompareAudio.py "golden/${image}32.stereo.f32" "build/firmware/Stereo.$image.f32"
    python3 tools/CompareAudio.py "golden/${image}32.mono.f32" "build/firmware/Mono.$image.f32"
    python3 tools/CompareAudio.py "golden/${image}32.stereo.f32" "build/firmware/StereoCmsis.$image.f32"
    python3 tools/CompareAudio.py "golden/$image.stereo.f32" "build/firmware/Stereo128.$image.f32"
    python3 tools/CompareAudio.py "golden/$image.mono.f32" "build/firmware/Mono128.$image.f32"
    python3 tools/CompareAudio.py "golden/$image.stereo.f32" "build/firmware/StereoCmsis128.$image.f32"
done
for image in Lanes Zones Hold Mods Steals; do
    python3 tools/CompareAudio.py "golden/$image.stereo.f32" "build/firmware/Stereo.$image.f32"
    python3 tools/CompareAudio.py "golden/$image.mono.f32" "build/firmware/Mono.$image.f32"
    python3 tools/CompareAudio.py "golden/$image.stereo.f32" "build/firmware/StereoCmsis.$image.f32"
done

# The board's firmware has the first 128 KB of flash, before slot A. Growing past the budget fails here first, with
# room still to spare, and Nucleo.ld fails one that would run into the slot.
budget=$((112 * 1024))
for name in Nucleo NucleoCmsis; do
    flash=$(arm-none-eabi-size -A "build/firmware/$name.elf" | awk '$1 == ".text" || $1 == ".ARM.exidx" || $1 == ".data" { n += $2 } END { print n }')
    echo "$name: $flash bytes of flash, of a budget of $budget"
    [ "$flash" -le "$budget" ] || { echo "$name is over its flash budget"; exit 1; }
done

# The profiles the compiler checks requests against are what the board's build says about itself.
for name in Nucleo NucleoCmsis; do
    python3 -c 'import json, sys; sys.exit(json.load(open(sys.argv[1])) != json.load(open(sys.argv[2])))' \
        "build/firmware/$name.json" "firmware/Profiles/$name.json" ||
        { echo "firmware/Profiles/$name.json differs from what the build wrote: copy build/firmware/$name.json"; exit 1; }
done

echo "== Fuzz"
cd build/firmware
timeout "$((${FUZZ_SECONDS:-60} + 120))" qemu-system-arm -machine mps2-an386 -cpu cortex-m4 -nographic -monitor none \
    -serial null -semihosting-config enable=on,target=native -kernel Fuzz.elf 2>&1
