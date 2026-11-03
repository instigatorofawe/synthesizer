# Built on its own, with firmware/ArmNoneEabi.cmake as the toolchain, so nothing here can pull in tests or the compiler.
cmake_minimum_required(VERSION 3.28)
project(modsynth_firmware LANGUAGES C CXX)
set(CMAKE_CXX_SCAN_FOR_MODULES OFF)

get_filename_component(MODSYNTH_GOLDEN ../golden ABSOLUTE)

include(FetchContent)
# SOURCE_SUBDIR points nowhere so that only the sources this firmware needs get built.
FetchContent_Declare(cmsis_dsp
    GIT_REPOSITORY https://github.com/ARM-software/CMSIS-DSP.git
    GIT_TAG v1.18.0
    GIT_SHALLOW TRUE
    SOURCE_SUBDIR none
)
FetchContent_Declare(cmsis_core
    GIT_REPOSITORY https://github.com/ARM-software/CMSIS_6.git
    GIT_TAG v6.4.0
    GIT_SHALLOW TRUE
    SOURCE_SUBDIR none
)
# Register definitions for the NUCLEO-L476RG's microcontroller.
FetchContent_Declare(cmsis_device_l4
    GIT_REPOSITORY https://github.com/STMicroelectronics/cmsis-device-l4.git
    GIT_TAG v1.7.5
    GIT_SHALLOW TRUE
    SOURCE_SUBDIR none
)
FetchContent_MakeAvailable(cmsis_dsp cmsis_core cmsis_device_l4)

set(ARCH -mcpu=cortex-m4 -mfpu=fpv4-sp-d16 -mfloat-abi=hard -mthumb)
set(CMSIS_DEFINES ARM_MATH_CM4 __FPU_PRESENT=1 ARM_MATH_LOOPUNROLL)
set(CMSIS_INCLUDES
    ${cmsis_dsp_SOURCE_DIR}/Include
    ${cmsis_dsp_SOURCE_DIR}/PrivateInclude
    ${cmsis_core_SOURCE_DIR}/CMSIS/Core/Include
)

add_library(cmsis_kernels OBJECT
    ${cmsis_dsp_SOURCE_DIR}/Source/FilteringFunctions/arm_biquad_cascade_df2T_f32.c
    ${cmsis_dsp_SOURCE_DIR}/Source/BasicMathFunctions/arm_mult_f32.c
    ${cmsis_dsp_SOURCE_DIR}/Source/BasicMathFunctions/arm_add_f32.c
    ${cmsis_dsp_SOURCE_DIR}/Source/BasicMathFunctions/arm_scale_f32.c
    ${cmsis_dsp_SOURCE_DIR}/Source/BasicMathFunctions/arm_offset_f32.c
    ${cmsis_dsp_SOURCE_DIR}/Source/SupportFunctions/arm_fill_f32.c
)
# -Ofast turns contraction on, so it is turned off again, to round as every other target does.
target_compile_options(cmsis_kernels PRIVATE ${ARCH} -Ofast -ffp-contract=off -ffunction-sections -fdata-sections)
target_compile_definitions(cmsis_kernels PRIVATE ${CMSIS_DEFINES})
target_include_directories(cmsis_kernels SYSTEM PRIVATE ${CMSIS_INCLUDES})

# What every Cortex-M build shares. Each links with its own script, as only some need the fuzzer's room.
function(configure_firmware name channels backend script)
    set_target_properties(${name} PROPERTIES SUFFIX .elf LINK_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/${script})
    target_compile_features(${name} PRIVATE cxx_std_23)
    target_include_directories(${name} PRIVATE ../include)
    target_compile_definitions(${name} PRIVATE MODSYNTH_CHANNELS=${channels})
    # No threadsafe statics: a guard variable would be the one route for threading symbols into this binary.
    target_compile_options(${name} PRIVATE ${ARCH} -O2 -ffp-contract=off -fno-math-errno -fno-exceptions -fno-rtti
        -fno-threadsafe-statics -ffunction-sections -fdata-sections -Wall -Wextra -Wno-psabi)
    target_link_options(${name} PRIVATE ${ARCH} -nostartfiles --specs=nano.specs --specs=nosys.specs
        -Wl,--gc-sections -T ${CMAKE_CURRENT_SOURCE_DIR}/${script})
    if(backend STREQUAL "cmsis")
        target_compile_definitions(${name} PRIVATE MODSYNTH_CMSIS ${CMSIS_DEFINES})
        target_include_directories(${name} SYSTEM PRIVATE ${CMSIS_INCLUDES})
        target_sources(${name} PRIVATE $<TARGET_OBJECTS:cmsis_kernels>)
    endif()
    add_custom_command(TARGET ${name} POST_BUILD COMMAND arm-none-eabi-size $<TARGET_FILE:${name}>)
endfunction()

function(add_firmware name channels backend frame)
    add_executable(${name} Main.cpp)
    configure_firmware(${name} ${channels} ${backend} Link.ld)
    target_compile_definitions(${name} PRIVATE
        MODSYNTH_FRAME=${frame}
        MODSYNTH_GOLDEN="${MODSYNTH_GOLDEN}"
        MODSYNTH_OUTPUT="${name}"
    )
endfunction()

# The default frame size, then the one the frozen images declare. An engine refuses any other size than its own.
add_firmware(Stereo 2 scalar 32)
add_firmware(Mono 1 scalar 32)
add_firmware(StereoCmsis 2 cmsis 32)
add_firmware(Stereo128 2 scalar 128)
add_firmware(Mono128 1 scalar 128)
add_firmware(StereoCmsis128 2 cmsis 128)

# The NUCLEO-L476RG: mono, since the DAC has one free channel. tools/Board.py talks to it. Each image slot is this big,
# and slot A ends bank 1, so what is left of bank 1 below it holds the firmware.
set(MODSYNTH_SLOT_KB 384)
math(EXPR MODSYNTH_SLOT_A "0x08080000 - ${MODSYNTH_SLOT_KB} * 1024" OUTPUT_FORMAT HEXADECIMAL)
foreach(build "Nucleo scalar" "NucleoCmsis cmsis")
    separate_arguments(build)
    list(GET build 0 name)
    list(GET build 1 backend)
    add_executable(${name} Nucleo.cpp)
    configure_firmware(${name} 1 ${backend} Nucleo.ld)
    target_compile_definitions(${name} PRIVATE STM32L476xx MODSYNTH_FRAME=32 MODSYNTH_SLOT_KB=${MODSYNTH_SLOT_KB}
        MODSYNTH_BULK_KB=64)
    target_link_options(${name} PRIVATE -Wl,--defsym=__slot_a=${MODSYNTH_SLOT_A})
    target_include_directories(${name} SYSTEM PRIVATE ${cmsis_device_l4_SOURCE_DIR}/Include
        ${cmsis_core_SOURCE_DIR}/CMSIS/Core/Include)
    # The profile the compiler checks requests against. Check.sh compares it with the one in firmware/Profiles.
    add_custom_command(TARGET ${name} POST_BUILD
        COMMAND arm-none-eabi-objcopy --dump-section .profile=${name}.profile.bin $<TARGET_FILE:${name}>
        COMMAND sh -c "tr -d '\\000' < ${name}.profile.bin > ${name}.json"
        WORKING_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}
        VERBATIM)
endforeach()

# Instruction counts for tools/Bench.py, which compiles the recipes these link. On the mps2-an386 as they need the room.
set(MODSYNTH_BENCH_RECIPES "" CACHE FILEPATH "The list of recipes tools/Bench.py wrote")
if(MODSYNTH_BENCH_RECIPES)
    foreach(build "BenchStereo 2 scalar" "BenchMono 1 scalar" "BenchCmsis 2 cmsis" "BenchMonoCmsis 1 cmsis")
        separate_arguments(build)
        list(GET build 0 name)
        list(GET build 1 channels)
        list(GET build 2 backend)
        add_executable(${name} Bench.cpp)
        configure_firmware(${name} ${channels} ${backend} An386.ld)
        target_include_directories(${name} PRIVATE ../bench)
        target_compile_definitions(${name} PRIVATE MODSYNTH_BENCH_RECIPES="${MODSYNTH_BENCH_RECIPES}")
    endforeach()
endif()

# The fuzzer, on QEMU's mps2-an386, whose Cortex-M4 has the room for it. Only Target.cpp is instrumented, so what a
# mutation discovers is new engine behaviour and not a new path through the mutator. It links first, so that an inline
# function both files use keeps its instrumented copy.
set(MODSYNTH_FUZZ_SEED_A ${MODSYNTH_GOLDEN}/AllOps.image CACHE FILEPATH "First image to fuzz from")
set(MODSYNTH_FUZZ_SEED_B ${MODSYNTH_GOLDEN}/Demo.image CACHE FILEPATH "Second image to fuzz from")
set(MODSYNTH_FUZZ_SEED_C ${MODSYNTH_GOLDEN}/Waves.image CACHE FILEPATH "Third image to fuzz from")
set(MODSYNTH_FUZZ_SEED_D ${MODSYNTH_GOLDEN}/Tones.image CACHE FILEPATH "Fourth image to fuzz from")
set(MODSYNTH_FUZZ_SEED_E ${MODSYNTH_GOLDEN}/AllOps32.image CACHE FILEPATH "Fifth image to fuzz from")
set(MODSYNTH_FUZZ_SEED_F ${MODSYNTH_GOLDEN}/Demo32.image CACHE FILEPATH "Sixth image to fuzz from")
set(MODSYNTH_FUZZ_SEED_G ${MODSYNTH_GOLDEN}/Waves32.image CACHE FILEPATH "Seventh image to fuzz from")
set(MODSYNTH_FUZZ_SEED_H ${MODSYNTH_GOLDEN}/Tones32.image CACHE FILEPATH "Eighth image to fuzz from")
set(MODSYNTH_FUZZ_SEED_I ${MODSYNTH_GOLDEN}/Lanes.image CACHE FILEPATH "Ninth image to fuzz from")
set(MODSYNTH_FUZZ_SEED_J ${MODSYNTH_GOLDEN}/Zones.image CACHE FILEPATH "Tenth image to fuzz from")
set(MODSYNTH_FUZZ_SEED_K ${MODSYNTH_GOLDEN}/Hold.image CACHE FILEPATH "Eleventh image to fuzz from")
set(MODSYNTH_FUZZ_SEED_L ${MODSYNTH_GOLDEN}/Mods.image CACHE FILEPATH "Twelfth image to fuzz from")
set(MODSYNTH_FUZZ_SEED_M ${MODSYNTH_GOLDEN}/Steals.image CACHE FILEPATH "Thirteenth image to fuzz from")
set(MODSYNTH_FUZZ_SECONDS 60 CACHE STRING "How long the fuzzer runs")
set(MODSYNTH_FUZZ_RANDOM 1 CACHE STRING "Random seed for the fuzzer")
set(FUZZ_FLAGS ${ARCH} -O2 -g -ffp-contract=off -fno-math-errno -fno-exceptions -fno-rtti -fno-threadsafe-statics
    -ffunction-sections -fdata-sections -Wall -Wextra -Wno-psabi)
add_library(fuzz_target OBJECT ../fuzz/Target.cpp)
target_compile_features(fuzz_target PRIVATE cxx_std_23)
target_include_directories(fuzz_target PRIVATE ../include)
target_compile_options(fuzz_target PRIVATE ${FUZZ_FLAGS} -fsanitize-coverage=trace-pc)

add_executable(Fuzz $<TARGET_OBJECTS:fuzz_target> Fuzz.cpp)
set_target_properties(Fuzz PROPERTIES SUFFIX .elf LINK_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/An386.ld)
target_compile_features(Fuzz PRIVATE cxx_std_23)
target_include_directories(Fuzz PRIVATE ../include)
target_compile_definitions(Fuzz PRIVATE
    MODSYNTH_FUZZ_SEED_A="${MODSYNTH_FUZZ_SEED_A}"
    MODSYNTH_FUZZ_SEED_B="${MODSYNTH_FUZZ_SEED_B}"
    MODSYNTH_FUZZ_SEED_C="${MODSYNTH_FUZZ_SEED_C}"
    MODSYNTH_FUZZ_SEED_D="${MODSYNTH_FUZZ_SEED_D}"
    MODSYNTH_FUZZ_SEED_E="${MODSYNTH_FUZZ_SEED_E}"
    MODSYNTH_FUZZ_SEED_F="${MODSYNTH_FUZZ_SEED_F}"
    MODSYNTH_FUZZ_SEED_G="${MODSYNTH_FUZZ_SEED_G}"
    MODSYNTH_FUZZ_SEED_H="${MODSYNTH_FUZZ_SEED_H}"
    MODSYNTH_FUZZ_SEED_I="${MODSYNTH_FUZZ_SEED_I}"
    MODSYNTH_FUZZ_SEED_J="${MODSYNTH_FUZZ_SEED_J}"
    MODSYNTH_FUZZ_SEED_K="${MODSYNTH_FUZZ_SEED_K}"
    MODSYNTH_FUZZ_SEED_L="${MODSYNTH_FUZZ_SEED_L}"
    MODSYNTH_FUZZ_SEED_M="${MODSYNTH_FUZZ_SEED_M}"
    MODSYNTH_FUZZ_SECONDS=${MODSYNTH_FUZZ_SECONDS}
    MODSYNTH_FUZZ_RANDOM=${MODSYNTH_FUZZ_RANDOM}
)
target_compile_options(Fuzz PRIVATE ${FUZZ_FLAGS})
target_link_options(Fuzz PRIVATE ${ARCH} -nostartfiles --specs=nano.specs --specs=nosys.specs
    -Wl,--gc-sections -T ${CMAKE_CURRENT_SOURCE_DIR}/An386.ld)
