#!/bin/sh
# Builds the firmware, runs it on QEMU's L475, and compares its audio with the desktop build of the same headers.
# Expects native tools in build/tools and the arm toolchain and QEMU on PATH.
set -e
cd "$(dirname "$0")/.."

mkdir -p build/firmware
build/tools/modsynth_compile examples/Demo.json build/firmware/Demo.image
cmake -S firmware -B build/firmware -G Ninja --toolchain "$PWD/firmware/ArmNoneEabi.cmake" \
    -DCMAKE_BUILD_TYPE=Release -DMODSYNTH_IMAGE="$PWD/build/firmware/Demo.image"
cmake --build build/firmware

firmware/CheckSymbols.sh build/firmware/Stereo.elf build/firmware/Mono.elf build/firmware/StereoCmsis.elf

cd build/firmware
for name in Stereo Mono StereoCmsis; do
    echo "== $name"
    timeout 120 qemu-system-arm -machine b-l475e-iot01a -cpu cortex-m4 -nographic -monitor none -serial null \
        -semihosting-config enable=on,target=native -kernel "$name.elf" 2>&1
done
cd ../..

build/tools/modsynth_render build/firmware/Demo.image build/firmware/NativeStereo.f32 1400 2
build/tools/modsynth_render build/firmware/Demo.image build/firmware/NativeMono.f32 1400 1
python3 tools/CompareAudio.py build/firmware/NativeStereo.f32 build/firmware/Stereo.f32
python3 tools/CompareAudio.py build/firmware/NativeMono.f32 build/firmware/Mono.f32
python3 tools/CompareAudio.py build/firmware/NativeStereo.f32 build/firmware/StereoCmsis.f32
