cmake_minimum_required(VERSION 3.28)
project(modsynth VERSION 0.1.0 LANGUAGES CXX) # pyproject.toml reads the version from this line

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_CXX_SCAN_FOR_MODULES OFF) # There are no modules, and scanning needs clang-scan-deps

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
option(MODSYNTH_BUILD_COMPILER "Build the authoring compiler, which firmware never links" ${MODSYNTH_DEV_BUILD})
option(MODSYNTH_BUILD_FUZZ "Build the coverage-guided fuzzer, with sanitizers" OFF)
option(MODSYNTH_INSTALL "Install the headers and CMake package" ${MODSYNTH_DEV_BUILD})

# Section 18's PoolExecutor, in modsynth/Parallel.hpp, needs threads. Wasm and bare metal have none, so there it is off and
# can't be turned on, and nothing they build can reach it.
if(EMSCRIPTEN OR CMAKE_SYSTEM_NAME STREQUAL "Generic")
    set(MODSYNTH_CAN_THREAD OFF)
else()
    set(MODSYNTH_CAN_THREAD ON)
endif()
option(MODSYNTH_PARALLEL "Build modsynth::parallel, the thread pool executor" ${MODSYNTH_CAN_THREAD})
if(MODSYNTH_PARALLEL AND NOT MODSYNTH_CAN_THREAD)
    message(FATAL_ERROR "MODSYNTH_PARALLEL needs threads, which Emscripten and bare-metal builds don't have")
endif()

add_library(modsynth INTERFACE)
add_library(modsynth::modsynth ALIAS modsynth)
target_include_directories(modsynth INTERFACE
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:include>
)
target_compile_features(modsynth INTERFACE cxx_std_23)
# Fused multiply-add rounds differently, enough to move a resonant filter by -100 dB, which is the limit golden audio allows.
# Wasm has none, so every target builds without it and they all round alike. See docs/Format.md section 10.
target_compile_options(modsynth INTERFACE $<$<PLATFORM_ID:Emscripten>:-msimd128> -ffp-contract=off)

if(MODSYNTH_PARALLEL)
    find_package(Threads REQUIRED)
    add_library(modsynth_parallel INTERFACE)
    add_library(modsynth::parallel ALIAS modsynth_parallel)
    set_target_properties(modsynth_parallel PROPERTIES EXPORT_NAME parallel)
    target_link_libraries(modsynth_parallel INTERFACE modsynth Threads::Threads)
endif()

# The Python module compiles requests too, so a wheel needs the compiler library, though not the command-line tools.
if(MODSYNTH_BUILD_COMPILER OR SKBUILD OR MODSYNTH_BUILD_PYTHON)
    include(FetchContent)
    FetchContent_Declare(nlohmann_json
        GIT_REPOSITORY https://github.com/nlohmann/json.git
        GIT_TAG v3.12.0
        GIT_SHALLOW TRUE
        EXCLUDE_FROM_ALL
        SYSTEM
        FIND_PACKAGE_ARGS 3.12
    )
    FetchContent_MakeAvailable(nlohmann_json)

    # Headers but for the peak check's engines, one per frame size and channel count, which compile once here rather than
    # in every file that includes the compiler. The Python module links it into a shared library, so it's PIC. Every
    # wasm build of the compiler catches its exceptions, so this file is built to pass them on.
    add_library(modsynth_compiler STATIC include/modsynth/Peak.cpp)
    add_library(modsynth::compiler ALIAS modsynth_compiler)
    target_link_libraries(modsynth_compiler PUBLIC modsynth nlohmann_json::nlohmann_json)
    set_target_properties(modsynth_compiler PROPERTIES POSITION_INDEPENDENT_CODE ON)
    target_compile_options(modsynth_compiler PRIVATE $<$<PLATFORM_ID:Emscripten>:-fwasm-exceptions>)
endif()

if(SKBUILD OR MODSYNTH_BUILD_PYTHON)
    find_package(Python 3.12 REQUIRED
        COMPONENTS Interpreter Development.Module
        OPTIONAL_COMPONENTS Development.SABIModule
    )
    find_package(nanobind CONFIG REQUIRED)

    # NOMINSIZE: nanobind defaults to -Os, which would also apply to the DSP templates
    # instantiated in this translation unit.
    if(NOT MODSYNTH_PARALLEL)
        message(FATAL_ERROR "The Python module renders on a thread pool, so it needs MODSYNTH_PARALLEL")
    endif()
    nanobind_add_module(_core NOMINSIZE STABLE_ABI bindings/Python.cpp)
    target_link_libraries(_core PRIVATE modsynth_compiler modsynth_parallel)
    install(TARGETS _core LIBRARY DESTINATION modsynth COMPONENT python)
elseif(EMSCRIPTEN AND PROJECT_IS_TOP_LEVEL)
    add_executable(modsynth_wasm bindings/Wasm.cpp)
    set_target_properties(modsynth_wasm PROPERTIES OUTPUT_NAME Modsynth)
    target_link_libraries(modsynth_wasm PRIVATE modsynth)

    # A single ES module that can be imported from an AudioWorkletProcessor without
    # SharedArrayBuffer. Worklets have no fetch(), so the wasm is embedded in the JS.
    # createModsynth() is async and addModule() doesn't wait for top-level await, so call
    # registerProcessor() first and only use the module once the promise resolves.
    # Memory growth stays off (the default): growing detaches any cached HEAPF32 subarray.
    # Plain C exports rather than embind, so the audio thread never allocates a binding object.
    target_link_options(modsynth_wasm PRIVATE
        -sEXPORT_ES6
        -sEXPORT_NAME=createModsynth
        -sSINGLE_FILE
        -sENVIRONMENT=web,worker,worklet,node
        -sEXPORTED_RUNTIME_METHODS=HEAPF32,HEAPU8
        -sFILESYSTEM=0
        -sINITIAL_MEMORY=134217728
        -sALLOW_MEMORY_GROWTH=0
    )

    # The compiler is a separate instance on a worker, per section 12, and also runs in Node for exports.
    # It allocates freely and throws, so it shares nothing with the worklet's heap.
    if(MODSYNTH_BUILD_COMPILER)
        add_executable(modsynth_compiler_wasm bindings/WasmCompiler.cpp)
        set_target_properties(modsynth_compiler_wasm PROPERTIES OUTPUT_NAME ModsynthCompiler)
        target_link_libraries(modsynth_compiler_wasm PRIVATE modsynth_compiler)
        target_compile_options(modsynth_compiler_wasm PRIVATE -fwasm-exceptions)
        target_link_options(modsynth_compiler_wasm PRIVATE
            -lembind
            -fwasm-exceptions
            -sEXPORT_ES6
            -sEXPORT_NAME=createCompiler
            -sSINGLE_FILE
            -sENVIRONMENT=web,worker,node
            -sFILESYSTEM=0
            -sALLOW_MEMORY_GROWTH=1
        )
    endif()
endif()

if(MODSYNTH_BUILD_TESTS OR MODSYNTH_BUILD_BENCH)
    include(FetchContent)
endif()

if(MODSYNTH_BUILD_COMPILER AND NOT EMSCRIPTEN)
    add_executable(modsynth_compile tools/CompileImage.cpp)
    target_link_libraries(modsynth_compile PRIVATE modsynth_compiler)
    add_executable(modsynth_render tools/Render.cpp)
    target_link_libraries(modsynth_render PRIVATE modsynth)
    add_executable(modsynth_work tools/Work.cpp)
    target_link_libraries(modsynth_work PRIVATE modsynth nlohmann_json::nlohmann_json)
endif()

if(MODSYNTH_BUILD_TESTS)
    enable_testing()

    # The compiler reports failures by throwing, which aborts the whole test under Emscripten's
    # default of no exception catching. Set here so it also reaches GoogleTest.
    if(EMSCRIPTEN)
        add_compile_options(-fwasm-exceptions)
        add_link_options(-fwasm-exceptions -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1048576 -sNODERAWFS=1)
        set(gtest_disable_pthreads ON CACHE BOOL "" FORCE)
    endif()

    set(BUILD_GMOCK OFF CACHE BOOL "" FORCE)
    set(INSTALL_GTEST OFF CACHE BOOL "" FORCE)
    FetchContent_Declare(googletest
        GIT_REPOSITORY https://github.com/google/googletest.git
        GIT_TAG v1.18.0
        GIT_SHALLOW TRUE
        EXCLUDE_FROM_ALL
        SYSTEM
        FIND_PACKAGE_ARGS NAMES GTest
    )
    FetchContent_MakeAvailable(googletest)
    include(GoogleTest)

    # The demo project is data, shared with the web app's seed, so embed it rather than copy it.
    file(READ examples/Demo.json MODSYNTH_DEMO_JSON)
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS examples/Demo.json)
    configure_file(examples/DemoJson.hpp.in generated/DemoJson.hpp @ONLY)

    # Tests sit beside what they test, as FooTest.cpp, and each file is its own target.
    file(GLOB_RECURSE MODSYNTH_TEST_SOURCES CONFIGURE_DEPENDS
        include/*Test.cpp
        bindings/*Test.cpp
        tools/*Test.cpp
    )
    if(NOT MODSYNTH_PARALLEL)
        list(FILTER MODSYNTH_TEST_SOURCES EXCLUDE REGEX "ParallelTest\\.cpp$")
    endif()
    foreach(source IN LISTS MODSYNTH_TEST_SOURCES)
        cmake_path(GET source STEM name)
        add_executable(${name} ${source})
        target_link_libraries(${name} PRIVATE modsynth_compiler GTest::gtest_main)
        if(name STREQUAL "ParallelTest")
            target_link_libraries(${name} PRIVATE modsynth_parallel)
        endif()
        target_include_directories(${name} PRIVATE ${CMAKE_CURRENT_BINARY_DIR}/generated)
        target_compile_definitions(${name} PRIVATE MODSYNTH_GOLDEN="${CMAKE_CURRENT_SOURCE_DIR}/golden"
            MODSYNTH_RECIPES="${CMAKE_CURRENT_SOURCE_DIR}/examples/Recipes"
            MODSYNTH_PIECES="${CMAKE_CURRENT_SOURCE_DIR}/examples/Pieces"
            MODSYNTH_PROFILES="${CMAKE_CURRENT_SOURCE_DIR}/firmware/Profiles")
        if(EMSCRIPTEN)
            add_test(NAME ${name} COMMAND ${name})
        else()
            gtest_discover_tests(${name})
        endif()
    endforeach()
endif()

if(MODSYNTH_BUILD_FUZZ)
    # Only Target.cpp is instrumented, so what a mutation discovers is new engine behaviour and not a new path through
    # the mutator. It links first, so that an inline function both files use keeps its instrumented copy.
    set(MODSYNTH_FUZZ_SANITIZE -fsanitize=address,undefined,float-cast-overflow -fno-sanitize-recover=all)
    add_library(modsynth_fuzz_target OBJECT fuzz/Target.cpp)
    target_link_libraries(modsynth_fuzz_target PRIVATE modsynth)
    target_compile_options(modsynth_fuzz_target PRIVATE
        ${MODSYNTH_FUZZ_SANITIZE} -O1 -g -fno-omit-frame-pointer -fsanitize-coverage=trace-pc-guard)
    add_executable(modsynth_fuzz $<TARGET_OBJECTS:modsynth_fuzz_target> fuzz/Main.cpp)
    target_link_libraries(modsynth_fuzz PRIVATE modsynth)
    target_compile_options(modsynth_fuzz PRIVATE ${MODSYNTH_FUZZ_SANITIZE} -O1 -g -fno-omit-frame-pointer)
    target_link_options(modsynth_fuzz PRIVATE ${MODSYNTH_FUZZ_SANITIZE})
    if(EMSCRIPTEN)
        target_link_options(modsynth_fuzz PRIVATE -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2147483648
            -sSTACK_SIZE=4194304 -sNODERAWFS=1)
    endif()
endif()

if(MODSYNTH_BUILD_BENCH)
    if(NOT MODSYNTH_BUILD_COMPILER)
        message(FATAL_ERROR "The benchmarks compile the recipes, so they need MODSYNTH_BUILD_COMPILER")
    endif()
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
    if(NOT MODSYNTH_PARALLEL)
        list(FILTER MODSYNTH_BENCH_SOURCES EXCLUDE REGEX "ParallelBench\\.cpp$")
    endif()
    add_executable(modsynth_bench ${MODSYNTH_BENCH_SOURCES})
    target_link_libraries(modsynth_bench PRIVATE modsynth_compiler benchmark::benchmark_main)
    if(MODSYNTH_PARALLEL)
        target_link_libraries(modsynth_bench PRIVATE modsynth_parallel)
    endif()
    target_compile_definitions(modsynth_bench PRIVATE MODSYNTH_RECIPES="${CMAKE_CURRENT_SOURCE_DIR}/examples/Recipes"
        MODSYNTH_PIECES="${CMAKE_CURRENT_SOURCE_DIR}/examples/Pieces")
endif()

if(MODSYNTH_INSTALL)
    include(CMakePackageConfigHelpers)
    set(MODSYNTH_CMAKE_DIR share/cmake/modsynth)

    install(TARGETS modsynth EXPORT modsynthTargets)
    if(MODSYNTH_PARALLEL)
        install(TARGETS modsynth_parallel EXPORT modsynthTargets)
    endif()
    install(DIRECTORY include/ DESTINATION include
        PATTERN "*Test.cpp" EXCLUDE
        PATTERN "TestSupport.hpp" EXCLUDE
        PATTERN "ShuffledExecutor.hpp" EXCLUDE
    )
    install(EXPORT modsynthTargets
        NAMESPACE modsynth::
        FILE modsynthTargets.cmake
        DESTINATION ${MODSYNTH_CMAKE_DIR}
    )
    # modsynth::parallel links Threads::Threads, which a consumer has to find before the targets load.
    file(CONFIGURE OUTPUT modsynthConfig.cmake CONTENT [=[
include(CMakeFindDependencyMacro)
if(@MODSYNTH_PARALLEL@)
    find_dependency(Threads)
endif()
include("${CMAKE_CURRENT_LIST_DIR}/modsynthTargets.cmake")
]=] @ONLY)
    install(FILES ${CMAKE_CURRENT_BINARY_DIR}/modsynthConfig.cmake DESTINATION ${MODSYNTH_CMAKE_DIR})
    write_basic_package_version_file(modsynthConfigVersion.cmake
        COMPATIBILITY SameMinorVersion
        ARCH_INDEPENDENT
    )
    install(FILES ${CMAKE_CURRENT_BINARY_DIR}/modsynthConfigVersion.cmake
        DESTINATION ${MODSYNTH_CMAKE_DIR}
    )
endif()
