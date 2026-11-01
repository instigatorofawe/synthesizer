#!/bin/sh
# Builds the firmware, runs it on QEMU's L475, and compares its audio with the golden renders. Then fuzzes on a Cortex-M4.
# Expects the arm toolchain and QEMU on PATH. FUZZ_SECONDS and FUZZ_RANDOM choose how long, and from what seed.
set -e
cd "$(dirname "$0")/.."

cmake -S firmware -B build/firmware -G Ninja --toolchain "$PWD/firmware/ArmNoneEabi.cmake" -DCMAKE_BUILD_TYPE=Release \
    -DMODSYNTH_FUZZ_SECONDS="${FUZZ_SECONDS:-60}" -DMODSYNTH_FUZZ_RANDOM="${FUZZ_RANDOM:-1}"
cmake --build build/firmware

firmware/CheckSymbols.sh build/firmware/Stereo.elf build/firmware/Mono.elf build/firmware/StereoCmsis.elf

cd build/firmware
for name in Stereo Mono StereoCmsis; do
    echo "== $name"
    timeout 120 qemu-system-arm -machine b-l475e-iot01a -cpu cortex-m4 -nographic -monitor none -serial null \
        -semihosting-config enable=on,target=native -kernel "$name.elf" 2>&1
done
cd ../..

for image in Demo AllOps Waves Tones; do
    python3 tools/CompareAudio.py "golden/$image.stereo.f32" "build/firmware/Stereo.$image.f32"
    python3 tools/CompareAudio.py "golden/$image.mono.f32" "build/firmware/Mono.$image.f32"
    python3 tools/CompareAudio.py "golden/$image.stereo.f32" "build/firmware/StereoCmsis.$image.f32"
done

echo "== Fuzz"
cd build/firmware
timeout "$((${FUZZ_SECONDS:-60} + 120))" qemu-system-arm -machine mps2-an386 -cpu cortex-m4 -nographic -monitor none \
    -serial null -semihosting-config enable=on,target=native -kernel Fuzz.elf 2>&1
