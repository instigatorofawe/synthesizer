#pragma once

// Section 18's parallel executor, for desktop builds. This is the only header that may include <thread> or <atomic>,
// and no other header includes it, so a build that never names PoolExecutor has no threading code. Link
// modsynth::parallel.
//
//     ThreadPool pool(8);
//     Synth<config, ScalarBackend, PoolExecutor<>> engine(memory, PoolExecutor<>{&pool});
//
// A task is a track's voices and inserts, or one bus, so a Program speeds up only as far as its tracks run side by
// side. Output is the same bits with any number of workers and with SerialExecutor.

#include <algorithm>
#include <atomic>
#include <cfenv>
#include <chrono>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

#include <modsynth/Executor.hpp>
#include <modsynth/Format.hpp>

namespace modsynth {

// Threads that run an engine's tasks. The thread that calls render() is a worker too, so a pool of n starts n - 1
// threads. Two engines may share a pool, and their frames then take turns.
class ThreadPool {
   public:
    explicit ThreadPool(u32 workers)
        : pending_(new std::atomic<u32>[kMaxTasks]), ready_(new std::atomic<u32>[kMaxTasks]) {
        const u32 threads = std::max<u32>(workers, 1) - 1;
        threads_.reserve(threads);
        for (u32 i = 0; i < threads; ++i) threads_.emplace_back([this, i] { serve(i + 1); });
    }

    ~ThreadPool() {
        stop_.store(true, std::memory_order_relaxed);
        epoch_.fetch_add(kNextFrame);
        epoch_.notify_all();
        for (std::thread& t : threads_) t.join();
    }

    ThreadPool(const ThreadPool&) = delete;
    ThreadPool& operator=(const ThreadPool&) = delete;

    [[nodiscard]] u32 workers() const { return static_cast<u32>(threads_.size()) + 1; }

    // Runs every task once, each after the tasks it depends on, and returns when all have finished. f(task, worker)
    // gets a worker below `most`, and must not throw.
    template <class F>
    void run(const Schedule& s, u32 most, F& f) {
        const std::lock_guard<std::mutex> turn(turn_);
        const u32 participants = std::min({most, workers(), s.count});
        if (participants <= 1 || chain(s)) {
            for (u32 t = 0; t < s.count; ++t) f(t, 0u);  // Edges only point forward, so listed order is a valid one
            return;
        }
        frame_.call = [](void* context, u32 task, u32 worker) { (*static_cast<F*>(context))(task, worker); };
        frame_.context = &f;
        frame_.schedule = &s;
        // Flush-to-zero is per thread, so a worker with another mode than the caller would round differently, and the
        // output would depend on which thread ran a task. Every worker takes the caller's mode for the frame.
        std::fegetenv(&frame_.env);
        u32 ready = 0;
        for (u32 t = 0; t < s.count; ++t) {
            pending_[t].store(s.deps[t], std::memory_order_relaxed);
            ready_[t].store(0, std::memory_order_relaxed);
        }
        for (u32 t = 0; t < s.count; ++t) {
            if (s.deps[t] == 0) ready_[ready++].store(t + 1, std::memory_order_relaxed);
        }
        published_.store(ready, std::memory_order_relaxed);
        claimed_.store(0, std::memory_order_relaxed);
        finished_.store(0, std::memory_order_relaxed);

        // The frame and how many take part go out in one word, so a thread late to one frame can't take another's
        // count. Sequentially consistent with the sleepers' count, so a thread about to sleep either sees this frame or
        // is counted and woken.
        const u64 epoch = epoch_.load(std::memory_order_relaxed);
        epoch_.store((epoch & ~kParticipants) + kNextFrame + participants);
        if (sleeping_.load() != 0) epoch_.notify_all();
        work(0);
        // Every thread taking part checks in before the next frame overwrites what this one reads. The rest touch
        // nothing but the epoch.
        for (u32 spin = 0; finished_.load(std::memory_order_acquire) != participants - 1; ++spin) pause(spin);
    }

   private:
    struct Frame {
        void (*call)(void*, u32, u32) = nullptr;
        void* context = nullptr;
        const Schedule* schedule = nullptr;
        std::fenv_t env{};
    };

    static constexpr u64 kParticipants = 0xFFFFFFFFull;
    static constexpr u64 kNextFrame = 1ull << 32;

    // A total order has an edge from each task to the next, and nothing in it can run alongside anything else. A
    // one-track Program is one: its track, then the master.
    static bool chain(const Schedule& s) {
        for (u32 t = 0; t + 1 < s.count; ++t) {
            if (s.succ_begin[t] == s.succ_begin[t + 1] || s.succ[s.succ_begin[t]] != t + 1) return false;
        }
        return true;
    }

    // Spinning keeps the next frame's start quick while a render is going. A thread sleeps once nothing has come for
    // this long, so an idle pool costs nothing.
    static constexpr auto kSpinFor = std::chrono::microseconds(200);

    static void pause(u32 spin) {
        if (spin < 64) {
#if defined(__x86_64__) || defined(__i386__)
            __builtin_ia32_pause();
#elif defined(__aarch64__)
            asm volatile("yield");
#endif
        } else {
            std::this_thread::yield();
        }
    }

    void serve(u32 id) {
        u64 seen = 0;
        for (;;) {
            const auto from = std::chrono::steady_clock::now();
            u64 now;
            for (u32 spin = 0; (now = epoch_.load(std::memory_order_acquire)) == seen; ++spin) {
                if ((spin & 63) != 63 || std::chrono::steady_clock::now() - from < kSpinFor) {
                    pause(spin);
                    continue;
                }
                sleeping_.fetch_add(1);
                epoch_.wait(seen);
                sleeping_.fetch_sub(1);
            }
            seen = now;
            if (stop_.load(std::memory_order_relaxed)) return;
            if (id >= (now & kParticipants)) continue;
            std::fesetenv(&frame_.env);
            work(id);
            finished_.fetch_add(1, std::memory_order_release);
        }
    }

    // Claims ready slots in order until every task has been claimed. A slot can be claimed before it is filled, and is
    // then waited for: whatever fills it is already running, because a task is published when its last dependency ends.
    void work(u32 worker) {
        const Schedule& s = *frame_.schedule;
        for (;;) {
            const u32 slot = claimed_.fetch_add(1, std::memory_order_relaxed);
            if (slot >= s.count) return;
            u32 task;
            for (u32 spin = 0; (task = ready_[slot].load(std::memory_order_acquire)) == 0; ++spin) pause(spin);
            --task;
            frame_.call(frame_.context, task, worker);
            for (u32 e = s.succ_begin[task]; e < s.succ_begin[task + 1]; ++e) {
                const u32 next = s.succ[e];
                if (pending_[next].fetch_sub(1, std::memory_order_acq_rel) == 1) {
                    ready_[published_.fetch_add(1, std::memory_order_relaxed)].store(next + 1,
                                                                                     std::memory_order_release);
                }
            }
        }
    }

    std::vector<std::thread> threads_;
    std::mutex turn_;
    Frame frame_;
    std::unique_ptr<std::atomic<u32>[]> pending_;  // dependencies each task still waits for
    std::unique_ptr<std::atomic<u32>[]> ready_;    // tasks in the order they became ready, plus one, or 0 for not yet
    alignas(64) std::atomic<u32> claimed_{0};
    alignas(64) std::atomic<u32> published_{0};
    alignas(64) std::atomic<u64> epoch_{0};  // frames so far, above how many threads take part in this one
    alignas(64) std::atomic<u32> finished_{0};
    alignas(64) std::atomic<u32> sleeping_{0};
    std::atomic<bool> stop_{false};
};

// Workers beyond MaxWorkers sit out, because each one needs its own scratch, and the engine sizes that at compile time.
// With no pool, every task runs on the calling thread.
template <u32 MaxWorkers = 16>
struct PoolExecutor {
    static_assert(MaxWorkers >= 1);
    static constexpr u32 max_workers = MaxWorkers;
    static constexpr bool uses_edges = true;
    using Plan = Schedule;

    ThreadPool* pool = nullptr;

    template <class F>
    void run(const Schedule& s, F&& f) {
        if (pool) {
            pool->run(s, MaxWorkers, f);
        } else {
            for (u32 t = 0; t < s.count; ++t) f(t, 0u);
        }
    }
};

}  // namespace modsynth
