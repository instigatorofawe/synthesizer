cmake_minimum_required(VERSION 3.28)
project(modsynth VERSION 0.1.0 LANGUAGES CXX) # pyproject.toml reads the version from this line

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# With no build type CMake compiles at -O0, which is a poor default for real-time audio
if(PROJECT_IS_TOP_LEVEL AND NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

# Only build tests when this project is the top-level build, and we are not building Python wheels
if(PROJECT_IS_TOP_LEVEL AND NOT SKBUILD)
    set(MODSYNTH_DEV_BUILD ON)
else()
    set(MODSYNTH_DEV_BUILD OFF)
endif()

option(MODSYNTH_BUILD_TESTS "Build the C++ tests" ${MODSYNTH_DEV_BUILD})
option(MODSYNTH_BUILD_BENCH "Build the benchmarks" OFF)
option(MODSYNTH_BUILD_PYTHON "Build the Python extension (always on for wheels)" OFF)
option(MODSYNTH_INSTALL "Install the headers and CMake package" ${MODSYNTH_DEV_BUILD})

add_library(modsynth INTERFACE)
add_library(modsynth::modsynth ALIAS modsynth)
target_include_directories(modsynth INTERFACE
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:include>
)
target_compile_features(modsynth INTERFACE cxx_std_23)
target_compile_options(modsynth INTERFACE $<$<PLATFORM_ID:Emscripten>:-msimd128>)

if(SKBUILD OR MODSYNTH_BUILD_PYTHON)
    find_package(Python 3.12 REQUIRED
        COMPONENTS Interpreter Development.Module
        OPTIONAL_COMPONENTS Development.SABIModule
    )
    find_package(nanobind CONFIG REQUIRED)

    # NOMINSIZE: nanobind defaults to -Os, which would also apply to the DSP templates
    # instantiated in this translation unit.
    nanobind_add_module(_core NOMINSIZE STABLE_ABI bindings/python.cpp)
    target_link_libraries(_core PRIVATE modsynth)
    install(TARGETS _core LIBRARY DESTINATION modsynth COMPONENT python)
elseif(EMSCRIPTEN AND PROJECT_IS_TOP_LEVEL)
    add_executable(modsynth_wasm bindings/wasm.cpp)
    set_target_properties(modsynth_wasm PROPERTIES OUTPUT_NAME modsynth)
    target_link_libraries(modsynth_wasm PRIVATE modsynth)

    # A single ES module that can be imported from an AudioWorkletProcessor without
    # SharedArrayBuffer. Worklets have no fetch(), so the wasm is embedded in the JS.
    # createModsynth() is async and addModule() doesn't wait for top-level await, so call
    # registerProcessor() first and only use the module once the promise resolves.
    # Memory growth stays off (the default): growing detaches any cached HEAPF32 subarray.
    target_link_options(modsynth_wasm PRIVATE
        -lembind
        -sEXPORT_ES6
        -sEXPORT_NAME=createModsynth
        -sSINGLE_FILE
        -sENVIRONMENT=web,worker,worklet,node
        -sEXPORTED_RUNTIME_METHODS=HEAPF32
        -sFILESYSTEM=0
    )
endif()

if(MODSYNTH_BUILD_TESTS OR MODSYNTH_BUILD_BENCH)
    include(FetchContent)
endif()

if(MODSYNTH_BUILD_TESTS)
    enable_testing()

    # Catch2's REQUIRE reports failures by throwing, which aborts the whole test run under
    # Emscripten's default of no exception catching. Set here so it also reaches Catch2.
    if(EMSCRIPTEN)
        add_compile_options(-fwasm-exceptions)
        add_link_options(-fwasm-exceptions)
    endif()

    FetchContent_Declare(Catch2
        GIT_REPOSITORY https://github.com/catchorg/Catch2.git
        GIT_TAG v3.16.1
        GIT_SHALLOW TRUE
        EXCLUDE_FROM_ALL
        SYSTEM
        FIND_PACKAGE_ARGS 3
    )
    FetchContent_MakeAvailable(Catch2)

    file(GLOB MODSYNTH_TEST_SOURCES CONFIGURE_DEPENDS test/*.cpp)
    add_executable(modsynth_tests ${MODSYNTH_TEST_SOURCES})
    target_link_libraries(modsynth_tests PRIVATE modsynth Catch2::Catch2WithMain)
    add_test(NAME modsynth_tests COMMAND modsynth_tests)
endif()

if(MODSYNTH_BUILD_BENCH)
    set(BENCHMARK_ENABLE_TESTING OFF)
    set(BENCHMARK_ENABLE_INSTALL OFF)
    FetchContent_Declare(benchmark
        GIT_REPOSITORY https://github.com/google/benchmark.git
        GIT_TAG v1.10.0
        GIT_SHALLOW TRUE
        EXCLUDE_FROM_ALL
        SYSTEM
        FIND_PACKAGE_ARGS
    )
    FetchContent_MakeAvailable(benchmark)

    file(GLOB MODSYNTH_BENCH_SOURCES CONFIGURE_DEPENDS bench/*.cpp)
    add_executable(modsynth_bench ${MODSYNTH_BENCH_SOURCES})
    target_link_libraries(modsynth_bench PRIVATE modsynth benchmark::benchmark_main)
endif()

if(MODSYNTH_INSTALL)
    include(CMakePackageConfigHelpers)
    set(MODSYNTH_CMAKE_DIR share/cmake/modsynth)

    install(TARGETS modsynth EXPORT modsynthTargets)
    install(DIRECTORY include/ DESTINATION include)
    install(EXPORT modsynthTargets
        NAMESPACE modsynth::
        FILE modsynthConfig.cmake
        DESTINATION ${MODSYNTH_CMAKE_DIR}
    )
    write_basic_package_version_file(modsynthConfigVersion.cmake
        COMPATIBILITY SameMinorVersion
        ARCH_INDEPENDENT
    )
    install(FILES ${CMAKE_CURRENT_BINARY_DIR}/modsynthConfigVersion.cmake
        DESTINATION ${MODSYNTH_CMAKE_DIR}
    )
endif()
