# Built on its own, with firmware/ArmNoneEabi.cmake as the toolchain, so nothing here can pull in tests or the compiler.
cmake_minimum_required(VERSION 3.28)
project(modsynth_firmware LANGUAGES C CXX)

set(MODSYNTH_IMAGE "" CACHE FILEPATH "Image to link into the firmware")
if(NOT MODSYNTH_IMAGE)
    message(FATAL_ERROR "Set MODSYNTH_IMAGE to an image from modsynth_compile")
endif()

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
FetchContent_MakeAvailable(cmsis_dsp cmsis_core)

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
target_compile_options(cmsis_kernels PRIVATE ${ARCH} -Ofast -ffunction-sections -fdata-sections)
target_compile_definitions(cmsis_kernels PRIVATE ${CMSIS_DEFINES})
target_include_directories(cmsis_kernels SYSTEM PRIVATE ${CMSIS_INCLUDES})

function(add_firmware name channels backend)
    add_executable(${name} Main.cpp)
    set_target_properties(${name} PROPERTIES SUFFIX .elf)
    target_compile_features(${name} PRIVATE cxx_std_23)
    target_include_directories(${name} PRIVATE ../include)
    target_compile_definitions(${name} PRIVATE
        MODSYNTH_CHANNELS=${channels}
        MODSYNTH_IMAGE_PATH="${MODSYNTH_IMAGE}"
        MODSYNTH_OUTPUT="${name}.f32"
    )
    # No threadsafe statics: a guard variable would be the one route for threading symbols into this binary.
    target_compile_options(${name} PRIVATE ${ARCH} -O2 -ffp-contract=off -fno-math-errno -fno-exceptions -fno-rtti
        -fno-threadsafe-statics -ffunction-sections -fdata-sections -Wall -Wextra -Wno-psabi)
    target_link_options(${name} PRIVATE ${ARCH} -nostartfiles --specs=nano.specs --specs=nosys.specs
        -Wl,--gc-sections -T ${CMAKE_CURRENT_SOURCE_DIR}/Link.ld)
    set_target_properties(${name} PROPERTIES LINK_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/Link.ld)
    target_link_libraries(${name} PRIVATE m)
    if(backend STREQUAL "cmsis")
        target_compile_definitions(${name} PRIVATE MODSYNTH_CMSIS ${CMSIS_DEFINES})
        target_include_directories(${name} SYSTEM PRIVATE ${CMSIS_INCLUDES})
        target_sources(${name} PRIVATE $<TARGET_OBJECTS:cmsis_kernels>)
    endif()
    add_custom_command(TARGET ${name} POST_BUILD COMMAND arm-none-eabi-size $<TARGET_FILE:${name}>)
endfunction()

add_firmware(Stereo 2 scalar)
add_firmware(Mono 1 scalar)
add_firmware(StereoCmsis 2 cmsis)
