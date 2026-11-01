#pragma once

// The core engine. Everything here builds for bare metal: no threads, no heap, no exceptions, no double on the run
// path. Authoring lives in modsynth/Compiler.hpp, and parallel execution in modsynth/Parallel.hpp. Firmware includes
// neither.

#include <modsynth/Backend.hpp>
#include <modsynth/Config.hpp>
#include <modsynth/Executor.hpp>
#include <modsynth/Format.hpp>
#include <modsynth/Kernels.hpp>
#include <modsynth/Loader.hpp>
#include <modsynth/Synth.hpp>
