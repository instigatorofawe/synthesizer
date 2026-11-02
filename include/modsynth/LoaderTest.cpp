#include <gtest/gtest.h>

#include <modsynth/TestSupport.hpp>

using namespace modsynth_test;
using compiler::compile_image;
using compiler::json;

namespace {

struct Bytes {
    explicit Bytes(const std::vector<std::byte>& b) : words((b.size() + 7) / 8), size(b.size()) {
        std::memcpy(words.data(), b.data(), b.size());
    }
    [[nodiscard]] ByteSpan span() const { return {reinterpret_cast<const std::byte*>(words.data()), size}; }
    [[nodiscard]] std::byte* data() { return reinterpret_cast<std::byte*>(words.data()); }
    std::vector<u64> words;
    std::size_t size;
};

LoadStatus load_all(Loader& l, ByteSpan image, u32 budget = 1 << 20, u32 frame_size = 0) {
    l.begin(image, frame_size);
    while (l.step(budget) == LoadStatus::Working) {
    }
    return l.status();
}

// Changes one chunk's payload and rebuilds the image around it, so the change gets past the hash and reaches the
// validator. Its hash moves, so where it sorts can too.
template <class F>
std::vector<std::byte> with_payload(const std::vector<std::byte>& image, ChunkKind kind, F&& change) {
    std::vector<compiler::Chunk> chunks = disassemble(image);
    for (compiler::Chunk& c : chunks) {
        if (c.kind != kind) continue;
        change(c.payload);
        c = compiler::detail::make_chunk(c.kind, std::move(c.payload));
        break;
    }
    return assemble(chunks, frame_size_of(load<ManifestHeader>(image.data() + sizeof(ChunkHeader))));
}

template <class T>
void poke(std::vector<std::byte>& bytes, std::size_t at, const T& value) {
    std::memcpy(bytes.data() + at, &value, sizeof value);
}

LoadError load_error(const std::vector<std::byte>& bytes, u32 frame_size = 0) {
    Bytes image(bytes);
    std::vector<ChunkRef> storage(kMaxChunks);
    ChunkTable table(storage);
    Loader loader(table);
    const LoadStatus status = load_all(loader, image.span(), 1 << 20, frame_size);
    EXPECT_EQ(status == LoadStatus::Ready, loader.error() == LoadError::None);
    if (status != LoadStatus::Ready) EXPECT_EQ(table.size(), 0u) << "a failed image must leave nothing behind";
    return loader.error();
}

// An image of hand-written chunks. A case changes one thing, and so each proves one rule of the validator.
struct Hand {
    HandPatch patch = minimal_patch();
    HandProgram program{};
    bool fresh_program = true;
    std::vector<compiler::Chunk> extra;

    [[nodiscard]] std::vector<std::byte> bytes() const {
        const compiler::Chunk p = patch.chunk();
        HandProgram prog = fresh_program ? minimal_program(p.hash) : program;
        if (!fresh_program) prog.patches[0] = p.hash;
        std::vector<compiler::Chunk> chunks = extra;
        chunks.push_back(p);
        chunks.push_back(prog.chunk());
        return assemble(chunks, kOriginalFrameSize);  // The size whose revision is only what its opcodes need
    }
};

// Fills bytes the compiler never would, and rewrites the manifest's hash so that only the bytes under test are wrong.
std::vector<std::byte> with_manifest(const std::vector<std::byte>& image, std::size_t at, const void* value,
                                     std::size_t size) {
    std::vector<std::byte> copy = image;
    std::memcpy(copy.data() + sizeof(ChunkHeader) + at, value, size);
    ChunkHeader h = load<ChunkHeader>(copy.data());
    h.hash = hash_bytes(hash_seed(ChunkKind::Manifest), copy.data() + sizeof(ChunkHeader), h.size);
    std::memcpy(copy.data(), &h, sizeof h);
    return copy;
}

}  // namespace

class LoaderFixture : public ::testing::Test {
   protected:
    LoaderFixture() : storage(kMaxChunks), table(storage) {}
    std::vector<ChunkRef> storage;
    ChunkTable table;
};

TEST_F(LoaderFixture, AcceptsTheDemoProject) {
    Bytes image(compile_demo());
    Loader loader(table);
    EXPECT_EQ(load_all(loader, image.span()), LoadStatus::Ready);
    EXPECT_EQ(loader.programs(), 2u);
}

TEST_F(LoaderFixture, OneUnitAtATimeReachesTheSameResult) {
    Bytes image(compile_demo());
    Loader loader(table);
    EXPECT_EQ(load_all(loader, image.span(), 1), LoadStatus::Ready);
}

TEST_F(LoaderFixture, EveryFlippedByteIsCaught) {
    const auto original = compile_demo();
    for (std::size_t at = 0; at < original.size(); at += at < 4096 ? 1 : 97) {
        Bytes image(original);
        image.data()[at] ^= std::byte{0x40};
        std::vector<ChunkRef> s(kMaxChunks);
        ChunkTable t(s);
        Loader loader(t);
        EXPECT_EQ(load_all(loader, image.span()), LoadStatus::Failed) << at;
        EXPECT_EQ(t.size(), 0u) << "a failed image must leave nothing behind";
    }
}

TEST_F(LoaderFixture, EveryTruncationFails) {
    const auto original = compile_demo();
    for (std::size_t size = 0; size < original.size(); size += 509) {
        Bytes image(original);
        Loader loader(table);
        EXPECT_EQ(load_all(loader, {image.span().data(), size}), LoadStatus::Failed) << size;
        EXPECT_EQ(table.size(), 0u);
    }
}

TEST_F(LoaderFixture, AHugeStepCountCannotWrapTheBoundsCheck) {
    const auto image = with_payload(compile_demo(), ChunkKind::Program, [](std::vector<std::byte>& p) {
        ProgramHeader h = load<ProgramHeader>(p.data());
        h.code = 0x20000000;  // times 8 is 2^32, which wraps to 0 on 32-bit
        poke(p, 0, h);
    });
    EXPECT_EQ(load_error(image), LoadError::BadProgram);
}

TEST(Rules, TheBaselineImageLoads) { EXPECT_EQ(load_error(Hand{}.bytes()), LoadError::None); }

TEST(Rules, ImageLayout) {
    const auto good = Hand{}.bytes();

    auto trailing = good;
    trailing.resize(good.size() + kChunkAlign);
    EXPECT_EQ(load_error(trailing), LoadError::BadChunk);

    auto padded = good;  // The minimal Program does not end on a boundary, so the image ends in padding
    ASSERT_NE(disassemble(good).back().payload.size() % kChunkAlign, 0u);
    padded.back() = std::byte{1};
    EXPECT_EQ(load_error(padded), LoadError::BadChunk);

    auto short_padding = good;
    short_padding.pop_back();
    EXPECT_EQ(load_error(short_padding), LoadError::BadChunk);

    const ManifestHeader h = load<ManifestHeader>(good.data() + sizeof(ChunkHeader));
    const u32 wrong_programs = h.programs + 1;
    EXPECT_EQ(load_error(with_manifest(good, offsetof(ManifestHeader, programs), &wrong_programs, 4)),
              LoadError::BadManifest);
    const u32 newer_revision = kFormatRevision + 1;
    EXPECT_EQ(load_error(with_manifest(good, offsetof(ManifestHeader, revision), &newer_revision, 4)),
              LoadError::TooNew);

    const u8 two = 2;
    EXPECT_EQ(load_error(with_manifest(good, sizeof(ManifestHeader) + offsetof(ManifestEntry, present), &two, 1)),
              LoadError::BadManifest);
    const u16 reserved = 1;
    EXPECT_EQ(load_error(with_manifest(good, sizeof(ManifestHeader) + offsetof(ManifestEntry, reserved), &reserved, 2)),
              LoadError::BadManifest);
    const u8 manifest_kind = 0;
    EXPECT_EQ(
        load_error(with_manifest(good, sizeof(ManifestHeader) + offsetof(ManifestEntry, kind), &manifest_kind, 1)),
        LoadError::BadManifest);

    auto newer = good;
    ChunkHeader first = load<ChunkHeader>(newer.data());
    first.version = kFormatVersion + 1;
    std::memcpy(newer.data(), &first, sizeof first);
    EXPECT_EQ(load_error(newer), LoadError::TooNew);
}

// An image with a frame size in its manifest, rebuilt from one with none.
std::vector<std::byte> at_frame_size(const std::vector<std::byte>& image, u32 frame_size, u32 revision) {
    const auto sized = with_manifest(image, offsetof(ManifestHeader, frame_size), &frame_size, 4);
    return with_manifest(sized, offsetof(ManifestHeader, revision), &revision, 4);
}

TEST(Rules, AFrameSizeHasOneEncodingAndARevision) {
    const auto good = Hand{}.bytes();
    ASSERT_EQ(load<ManifestHeader>(good.data() + sizeof(ChunkHeader)).frame_size, 0u);

    EXPECT_EQ(load_error(at_frame_size(good, 32, kFrameSizeRevision)), LoadError::None);
    EXPECT_EQ(load_error(at_frame_size(good, 8, kFrameSizeRevision)), LoadError::None);
    EXPECT_EQ(load_error(at_frame_size(good, 1024, kFrameSizeRevision)), LoadError::None);

    EXPECT_EQ(load_error(at_frame_size(good, 128, kFormatRevision)), LoadError::BadManifest) << "128 is written as 0";
    EXPECT_EQ(load_error(at_frame_size(good, 32, kFrameSizeRevision - 1)), LoadError::BadManifest);
    for (const u32 size : {1u, 3u, 4u, 48u, 2048u}) {
        EXPECT_EQ(load_error(at_frame_size(good, size, kFrameSizeRevision)), LoadError::BadManifest) << size;
    }
}

TEST(Rules, ALoaderHeldToAFrameSizeRefusesAnother) {
    const auto original = Hand{}.bytes();
    const auto frame32 = at_frame_size(original, 32, kFrameSizeRevision);
    EXPECT_EQ(load_error(original, 128), LoadError::None);
    EXPECT_EQ(load_error(original, 32), LoadError::WrongFrameSize);  // load_error also checks nothing was left behind
    EXPECT_EQ(load_error(frame32, 32), LoadError::None);
    EXPECT_EQ(load_error(frame32, 128), LoadError::WrongFrameSize);
}

TEST(Rules, OneTableHoldsOneFrameSize) {
    const auto original = Hand{}.bytes();
    std::vector<ChunkRef> storage(kMaxChunks);
    ChunkTable table(storage);
    EXPECT_EQ(table.frame_size(), 0u);

    Bytes first(original);
    Loader loader(table);
    ASSERT_EQ(load_all(loader, first.span()), LoadStatus::Ready);
    EXPECT_EQ(table.frame_size(), 128u);
    const u32 size = table.size();

    Bytes second(at_frame_size(original, 32, kFrameSizeRevision));
    Loader refused(table);
    EXPECT_EQ(load_all(refused, second.span()), LoadStatus::Failed);
    EXPECT_EQ(refused.error(), LoadError::WrongFrameSize);
    EXPECT_EQ(table.size(), size);
    EXPECT_EQ(table.frame_size(), 128u);

    table.clear();
    EXPECT_EQ(table.frame_size(), 0u);
    Loader fresh(table);
    EXPECT_EQ(load_all(fresh, second.span()), LoadStatus::Ready);
    EXPECT_EQ(table.frame_size(), 32u);
}

TEST(Rules, AHostCanReadAnImagesFrameSize) {
    Bytes original(Hand{}.bytes());
    EXPECT_EQ(image_frame_size(original.span()), 128u);
    Bytes frame32(at_frame_size(Hand{}.bytes(), 32, kFrameSizeRevision));
    EXPECT_EQ(image_frame_size(frame32.span()), 32u);

    const std::size_t header = sizeof(ChunkHeader) + sizeof(ManifestHeader);
    EXPECT_EQ(image_frame_size({original.span().data(), header}), 128u);
    EXPECT_EQ(image_frame_size({original.span().data(), header - 1}), 0u);
    EXPECT_EQ(image_frame_size({}), 0u);
}

TEST(Rules, AnImageMustDeclareTheRevisionOfItsOpcodes) {
    Hand hand;
    hand.patch.voice[0].op = static_cast<u8>(Op::Saw);
    const auto declared = hand.bytes();
    ASSERT_EQ(load<ManifestHeader>(declared.data() + sizeof(ChunkHeader)).revision, 1u);
    EXPECT_EQ(load_error(declared), LoadError::None);

    // Saying 0 would get an old engine to call this damaged, when it only needs to be newer.
    const u32 zero = 0;
    EXPECT_EQ(load_error(with_manifest(declared, offsetof(ManifestHeader, revision), &zero, 4)), LoadError::BadPatch);
}

TEST(Rules, ARevisionCoversOnlyTheOpcodesUpToIt) {
    Hand hand;
    hand.patch.voice[0].op = static_cast<u8>(Op::Tone);
    const auto declared = hand.bytes();
    ASSERT_EQ(load<ManifestHeader>(declared.data() + sizeof(ChunkHeader)).revision, 2u);
    EXPECT_EQ(load_error(declared), LoadError::None);

    const u32 one = 1;
    EXPECT_EQ(load_error(with_manifest(declared, offsetof(ManifestHeader, revision), &one, 4)), LoadError::BadPatch);
}

TEST(Rules, ChunksMustBeInManifestOrder) {
    HandPatch other = minimal_patch();
    other.consts = {0.25f};
    Hand hand;
    hand.extra = {other.chunk()};
    const auto good = hand.bytes();
    ASSERT_EQ(load_error(good), LoadError::None);

    // Swap the first two manifest entries, so the list is no longer sorted by hash.
    std::vector<std::byte> entries(2 * sizeof(ManifestEntry));
    const std::byte* first = good.data() + sizeof(ChunkHeader) + sizeof(ManifestHeader);
    std::memcpy(entries.data(), first + sizeof(ManifestEntry), sizeof(ManifestEntry));
    std::memcpy(entries.data() + sizeof(ManifestEntry), first, sizeof(ManifestEntry));
    EXPECT_EQ(load_error(with_manifest(good, sizeof(ManifestHeader), entries.data(), entries.size())),
              LoadError::BadManifest);
}

TEST(Rules, AHashCoversTheVersionByte) {
    const std::byte payload[4] = {};
    EXPECT_NE(hash_bytes(hash_seed(ChunkKind::Patch, 1), payload, 4),
              hash_bytes(hash_seed(ChunkKind::Patch, 2), payload, 4));
    EXPECT_NE(hash_bytes(hash_seed(ChunkKind::Patch), payload, 4), hash_bytes(hash_seed(ChunkKind::Table), payload, 4));
}

TEST(Rules, TheHashGoldenValueNeverChanges) {
    // FNV-1a 64 over "a", from its published test vectors, and then version 1's seeding of a Table chunk, worked out
    // independently in Python.
    const std::byte a{'a'};
    EXPECT_EQ(hash_bytes(kHashSeed, &a, 1), 0xaf63dc4c8601ec8cull);
    EXPECT_EQ(hash_seed(ChunkKind::Table, 1), 0x82f2407b4e8902aull);
}

TEST(Rules, SmallCorruptionCannotCollide) {
    // Two runs of a chunk-sized message with every one or two neighbouring bytes changed. Each step of FNV-1a is a
    // bijection, so one changed byte can never collide, and the multiplier spreads two too far to cancel.
    std::vector<std::byte> message(256);
    for (std::size_t i = 0; i < message.size(); ++i) message[i] = static_cast<std::byte>(i * 37);
    const u64 original = hash_bytes(kHashSeed, message.data(), message.size());
    for (std::size_t at = 0; at + 1 < message.size(); at += 13) {
        for (u32 x = 1; x < 256; x += 5) {
            for (u32 y = 0; y < 256; y += 5) {
                auto changed = message;
                changed[at] ^= static_cast<std::byte>(x);
                changed[at + 1] ^= static_cast<std::byte>(y);
                ASSERT_NE(hash_bytes(kHashSeed, changed.data(), changed.size()), original);
            }
        }
    }
}

namespace {

WireStep step(Op op, std::initializer_list<u16> outs, std::initializer_list<u16> ins) {
    WireStep s{};
    s.op = static_cast<u8>(op);
    std::copy(outs.begin(), outs.end(), s.out);
    std::copy(ins.begin(), ins.end(), s.in);
    return s;
}

const u16 kBuffer0 = operand(Bank::Buffer, 0);
const u16 kBuffer1 = operand(Bank::Buffer, 1);
const u16 kConst0 = operand(Bank::Const, 0);

ParamDesc param(u16 id, ParamScope scope, u16 reg) {
    ParamDesc d{};
    d.id = id;
    d.scope = static_cast<u8>(scope);
    d.reg = reg;
    d.max = 1.0f;
    return d;
}

struct PatchCase {
    const char* name;
    void (*change)(HandPatch&);
};

const PatchCase kPatchCases[] = {
    {"a reserved header field", [](HandPatch& p) { p.header.reserved = 1; }},
    {"a reserved param field",
     [](HandPatch& p) {
         p.params = {param(1, ParamScope::Global, 0)};
         p.params[0].reserved = 1;
     }},
    {"param ids out of order",
     [](HandPatch& p) { p.params = {param(2, ParamScope::Global, 0), param(1, ParamScope::Global, 0)}; }},
    {"a repeated param id",
     [](HandPatch& p) { p.params = {param(1, ParamScope::Global, 0), param(1, ParamScope::Global, 0)}; }},
    {"a default below min",
     [](HandPatch& p) {
         p.params = {param(1, ParamScope::Global, 0)};
         p.params[0].min = 0.5f;
     }},
    {"a global param with a register", [](HandPatch& p) { p.params = {param(1, ParamScope::Global, 1)}; }},
    {"a param on a builtin scalar", [](HandPatch& p) { p.params = {param(1, ParamScope::Voice, kScalarGate)}; }},
    {"two params on one register",
     [](HandPatch& p) {
         p.header.track_scalars = 1;
         p.params = {param(1, ParamScope::Track, 0), param(2, ParamScope::Track, 0)};
     }},
    {"too many steps", [](HandPatch& p) { p.voice.assign(kMaxPatchSteps + 1, step(Op::Fill, {kBuffer0}, {kConst0})); }},
    {"too many delay lines", [](HandPatch& p) { p.delays.assign(kMaxPatchDelays + 1, 1.0f); }},
    {"a delay line over a minute", [](HandPatch& p) { p.delays = {60.5f}; }},
    {"an unknown op", [](HandPatch& p) { p.voice[0].op = static_cast<u8>(Op::kCount); }},
    {"op zero", [](HandPatch& p) { p.voice[0].op = 0; }},
    {"a mode on an op without one", [](HandPatch& p) { p.voice[0].mode = 1; }},
    {"a resource on an op without one", [](HandPatch& p) { p.voice[0].resource = 1; }},
    {"a third input on Fill", [](HandPatch& p) { p.voice[0].in[2] = kConst0; }},
    {"a second output on Fill", [](HandPatch& p) { p.voice[0].out[1] = kBuffer1; }},
    {"a Biquad mode past the last",
     [](HandPatch& p) {
         p.voice.push_back(step(Op::Biquad, {kBuffer0}, {kBuffer0, kConst0, kConst0}));
         p.voice[1].mode = 3;
     }},
    {"a control step using a buffer", [](HandPatch& p) { p.control = {step(Op::Fill, {kBuffer0}, {kConst0})}; }},
    {"a control step taking a KSnap",
     [](HandPatch& p) {
         p.header.track_scalars = 1;
         p.control = {step(Op::KSnap, {operand(Bank::Track, 0)}, {kBuffer0})};
     }},
    {"a stereo op writing one register twice",
     [](HandPatch& p) {
         p.header.buffers = 2;
         p.voice.push_back(step(Op::Pan, {kBuffer1, kBuffer1}, {kBuffer0, kConst0}));
     }},
    {"a stereo op writing over its input",
     [](HandPatch& p) {
         p.header.buffers = 2;
         p.voice.push_back(step(Op::Pan, {kBuffer0, kBuffer1}, {kBuffer0, kConst0}));
     }},

    // Section 18 of the design, one rule per case.
    {"a voice step writing a global scalar",
     [](HandPatch& p) {
         p.params = {param(1, ParamScope::Global, 0)};
         p.voice.push_back(step(Op::KAdd, {operand(Bank::Global, 0)}, {kConst0, kConst0}));
     }},
    {"a control step writing a global scalar",
     [](HandPatch& p) {
         p.params = {param(1, ParamScope::Global, 0)};
         p.control = {step(Op::KAdd, {operand(Bank::Global, 0)}, {kConst0, kConst0})};
     }},
    {"a voice step writing a track scalar, which every voice on the track shares",
     [](HandPatch& p) {
         p.header.track_scalars = 1;
         p.voice.push_back(step(Op::KAdd, {operand(Bank::Track, 0)}, {kConst0, kConst0}));
     }},
    {"a control step reading a voice scalar, since no voice exists then",
     [](HandPatch& p) {
         p.header.track_scalars = 1;
         p.control = {step(Op::KAdd, {operand(Bank::Track, 0)}, {operand(Bank::Voice, kScalarNote), kConst0})};
     }},
    {"a control step writing a voice scalar",
     [](HandPatch& p) {
         p.header.voice_scalars = kBuiltinVoiceScalars + 1;
         p.control = {step(Op::KAdd, {operand(Bank::Voice, kBuiltinVoiceScalars)}, {kConst0, kConst0})};
     }},
    {"a step writing the gate, which belongs to the engine",
     [](HandPatch& p) { p.voice.push_back(step(Op::KAdd, {operand(Bank::Voice, kScalarGate)}, {kConst0, kConst0})); }},
    {"a step writing a voice param, which a ramp also writes",
     [](HandPatch& p) {
         p.header.voice_scalars = kBuiltinVoiceScalars + 1;
         p.params = {param(1, ParamScope::Voice, kBuiltinVoiceScalars)};
         p.voice.push_back(step(Op::KAdd, {operand(Bank::Voice, kBuiltinVoiceScalars)}, {kConst0, kConst0}));
     }},
    {"a control step writing a track param",
     [](HandPatch& p) {
         p.header.track_scalars = 1;
         p.params = {param(1, ParamScope::Track, 0)};
         p.control = {step(Op::KAdd, {operand(Bank::Track, 0)}, {kConst0, kConst0})};
     }},
    {"reading a voice scalar before anything wrote it",
     [](HandPatch& p) {
         p.header.voice_scalars = kBuiltinVoiceScalars + 1;
         p.voice.push_back(step(Op::Fill, {kBuffer0}, {operand(Bank::Voice, kBuiltinVoiceScalars)}));
     }},
    {"reading a buffer before anything wrote it",
     [](HandPatch& p) {
         p.header.buffers = 2;
         p.voice.push_back(step(Op::Mul, {kBuffer0}, {kBuffer1, kBuffer1}));
     }},
};

struct ProgramCase {
    const char* name;
    void (*change)(HandProgram&);
};

Instruction instr(Instr op, u8 a, u16 b, u32 c) { return {static_cast<u8>(op), a, b, c}; }

// Puts these at the head of the one track's stream, so that they are the only thing wrong with it.
void prepend(HandProgram& p, std::initializer_list<Instruction> code) {
    const u32 count = static_cast<u32>(code.size());
    p.code.insert(p.code.begin(), code);
    p.tracks[0].stream_length += count;
    p.header.conductor_begin += count;
}

const ProgramCase kProgramCases[] = {
    {"a feature no revision defines", [](HandProgram& p) { p.header.features = 4; }},
    {"a feature its code does not use", [](HandProgram& p) { p.header.features = kFeatureMixRamps; }},
    {"a wrong length", [](HandProgram& p) { p.header.length_ticks = 1; }},
    {"no end to a stream", [](HandProgram& p) { p.code[0] = instr(Instr::Wait, 0, 0, 1); }},
    {"End in the middle of a stream",
     [](HandProgram& p) {
         p.code.insert(p.code.begin(), instr(Instr::End, 0, 0, 0));
         p.tracks[0].stream_length = 2;
         p.header.conductor_begin = 2;
     }},
    {"an unused instruction field",
     [](HandProgram& p) {
         p.code.insert(p.code.begin(), instr(Instr::Wait, 1, 0, 1));
         p.tracks[0].stream_length = 2;
         p.header.conductor_begin = 2;
         p.header.length_ticks = 1;
     }},
    {"a stream too long to count in a u32",
     [](HandProgram& p) {
         p.code.insert(p.code.begin(), {instr(Instr::Wait, 0, 0, 0xFFFFFFFF), instr(Instr::Wait, 0, 0, 2)});
         p.tracks[0].stream_length = 3;
         p.header.conductor_begin = 3;
         p.header.length_ticks = 1;
     }},
    {"a note that outlasts the clock",
     [](HandProgram& p) {
         p.code.insert(p.code.begin(), instr(Instr::NoteOn, 60, 100, kMaxTicks + 1));
         p.tracks[0].stream_length = 2;
         p.header.conductor_begin = 2;
     }},
    {"a clip with no ticks", [](HandProgram& p) { p.clips = {ClipDesc{0, 0, 0, 0}}; }},
    {"a clip whose declared ticks are wrong",
     [](HandProgram& p) {
         p.code.push_back(instr(Instr::Wait, 0, 0, 4));
         p.clips = {ClipDesc{2, 1, 5, 0}};
     }},
    {"a clip ending in End",
     [](HandProgram& p) {
         p.code.push_back(instr(Instr::Wait, 0, 0, 4));
         p.code.push_back(instr(Instr::End, 0, 0, 0));
         p.clips = {ClipDesc{2, 2, 4, 0}};
     }},
    {"a clip understating its slots",
     [](HandProgram& p) {
         p.code.push_back(instr(Instr::SetPatch, 3, 0, 0));
         p.code.push_back(instr(Instr::Wait, 0, 0, 4));
         p.clips = {ClipDesc{2, 2, 4, 1}};
     }},
    {"a clip using a slot its track lacks",
     [](HandProgram& p) {
         p.code = {instr(Instr::Call, 0, 0, 1), instr(Instr::End, 0, 0, 0), instr(Instr::End, 0, 0, 0),
                   instr(Instr::SetPatch, 1, 0, 0), instr(Instr::Wait, 0, 0, 4)};
         p.clips = {ClipDesc{3, 2, 4, 2}};
         p.tracks[0].stream_length = 2;
         p.header.conductor_begin = 2;
         p.header.length_ticks = 4;
     }},
    {"repeats too many to unroll",
     [](HandProgram& p) {
         p.code = {instr(Instr::Call, 0, 0, kMaxExpanded), instr(Instr::End, 0, 0, 0), instr(Instr::End, 0, 0, 0),
                   instr(Instr::Wait, 0, 0, 1)};
         p.clips = {ClipDesc{3, 1, 1, 0}};
         p.tracks[0].stream_length = 2;
         p.header.conductor_begin = 2;
         p.header.length_ticks = kMaxExpanded;
     }},
    {"a Tempo on a track",
     [](HandProgram& p) {
         p.code.insert(p.code.begin(), instr(Instr::Tempo, 0, 0, 500000));
         p.tracks[0].stream_length = 2;
         p.header.conductor_begin = 2;
     }},
    {"a Ramp with no time",
     [](HandProgram& p) {
         p.code.insert(p.code.begin(), {instr(Instr::Ramp, 0, 1, 0), instr(Instr::RampArg, 0, 0, 0)});
         p.tracks[0].stream_length = 3;
         p.header.conductor_begin = 3;
     }},
    {"two tracks sharing a slot", [](HandProgram& p) { p.tracks.push_back(TrackDesc{2, 1, 0, 1, 0, 1}); }},
    {"a slot nothing owns", [](HandProgram& p) { p.slots.push_back(0); }},
    {"two tracks with one id",
     [](HandProgram& p) {
         p.slots.push_back(0);
         p.tracks.push_back(TrackDesc{1, 1, 1, 1, 0, 1});
     }},
    {"too many voices", [](HandProgram& p) { p.tracks[0].voices = kMaxVoices + 1; }},

    // Section 18: an instance belongs to exactly one task.
    {"a track run by two mixer steps",
     [](HandProgram& p) {
         p.header.buses = 2;
         p.mix.push_back(MixStep{static_cast<u8>(MixOp::RunVoices), 0, 1, 0, 1, 0, kNone});
     }},
    {"a Gather reading its own output",
     [](HandProgram& p) {
         p.gather = {GatherInput{0, 0, 1, 0}};
         p.mix_init = {1.0f, 1.0f};
         p.mix.push_back(MixStep{static_cast<u8>(MixOp::Gather), 0, 1, 0, 0, 1, kNone});
     }},
    {"a Gather reading a bus nothing wrote",
     [](HandProgram& p) {
         p.header.buses = 2;
         p.gather = {GatherInput{1, 0, 1, 0}};
         p.mix_init = {1.0f, 1.0f};
         p.mix.push_back(MixStep{static_cast<u8>(MixOp::Gather), 0, 1, 0, 0, 1, kNone});
     }},
    {"tasks running backwards",
     [](HandProgram& p) {
         p.mix[0].task = 1;
         p.gather = {GatherInput{0, 0, 1, 0}};
         p.mix_init = {1.0f, 1.0f};
         p.header.buses = 2;
         p.mix.push_back(MixStep{static_cast<u8>(MixOp::Gather), 0, 0, 0, 1, 1, kNone});
     }},
    {"a task number that skips",
     [](HandProgram& p) {
         p.gather = {GatherInput{0, 0, 1, 0}};
         p.mix_init = {1.0f, 1.0f};
         p.header.buses = 2;
         p.mix.push_back(MixStep{static_cast<u8>(MixOp::Gather), 0, 2, 0, 1, 1, kNone});
     }},

    {"a reserved mix field", [](HandProgram& p) { p.mix[0].reserved = 1; }},
    {"a stray source on RunVoices", [](HandProgram& p) { p.mix[0].src = 1; }},
    {"a stray key on RunVoices", [](HandProgram& p) { p.mix[0].key = 0; }},
    {"a stray key on Gather",
     [](HandProgram& p) {
         p.header.buses = 2;
         p.mix.push_back(MixStep{static_cast<u8>(MixOp::Gather), 0, 1, 0, 1, 0, 0});
     }},
    {"a reserved gather field",
     [](HandProgram& p) {
         p.header.buses = 2;
         p.gather = {GatherInput{0, 0, 1, 1}};
         p.mix_init = {1.0f, 1.0f};
         p.mix.push_back(MixStep{static_cast<u8>(MixOp::Gather), 0, 1, 0, 1, 1, kNone});
     }},
    {"mixer op zero", [](HandProgram& p) { p.mix[0].op = 0; }},
    {"a reserved global field", [](HandProgram& p) { p.globals = {GlobalDesc{1, 1, 0.0f}}; }},
    {"globals out of order", [](HandProgram& p) { p.globals = {GlobalDesc{2, 0, 0.0f}, GlobalDesc{1, 0, 0.0f}}; }},
    {"a reserved init field", [](HandProgram& p) { p.inits = {ParamInit{0, 0, 1, 1, 0.0f}}; }},
    {"a lane on an insert that does not exist", [](HandProgram& p) { prepend(p, {instr(Instr::SetInsert, 0, 1, 0)}); }},
    {"a ramp on an insert that does not exist",
     [](HandProgram& p) { prepend(p, {instr(Instr::RampInsert, 0, 1, 0), instr(Instr::RampArg, 0, 0, 1)}); }},
    {"a lane on a mix register that does not exist",
     [](HandProgram& p) { prepend(p, {instr(Instr::SetMix, 0, 0, 0)}); }},
    {"a mix ramp on a register that does not exist",
     [](HandProgram& p) {
         p.header.features = kFeatureMixRamps;
         prepend(p, {instr(Instr::RampMix, 0, 0, 0), instr(Instr::RampArg, 0, 0, 1)});
     }},
    {"a mix ramp with no feature",
     [](HandProgram& p) {
         p.mix_init = {1.0f};
         prepend(p, {instr(Instr::RampMix, 0, 0, 0), instr(Instr::RampArg, 0, 0, 1)});
     }},
    {"a mix ramp with no ticks",
     [](HandProgram& p) {
         p.mix_init = {1.0f};
         p.header.features = kFeatureMixRamps;
         prepend(p, {instr(Instr::RampMix, 0, 0, 0), instr(Instr::RampArg, 0, 0, 0)});
     }},
    {"a mix value that is not finite",
     [](HandProgram& p) {
         p.mix_init = {1.0f};
         prepend(p, {instr(Instr::SetMix, 0, 0, std::bit_cast<u32>(NAN))});
     }},
    {"a play mode with no feature", [](HandProgram& p) { prepend(p, {instr(Instr::PlayMode, 1, 0, 0)}); }},
    {"a play mode that does not exist",
     [](HandProgram& p) {
         p.header.features = kFeaturePlayModes;
         prepend(p, {instr(Instr::PlayMode, 3, 0, 0)});
     }},
    {"a priority that does not exist",
     [](HandProgram& p) {
         p.header.features = kFeaturePlayModes;
         prepend(p, {instr(Instr::PlayMode, 1, 3, 0)});
     }},
    {"a priority on poly",
     [](HandProgram& p) {
         p.header.features = kFeaturePlayModes;
         prepend(p, {instr(Instr::PlayMode, 0, 1, 0)});
     }},
    {"a glide that is too long",
     [](HandProgram& p) {
         p.header.features = kFeaturePlayModes;
         prepend(p, {instr(Instr::PlayMode, 1, 0, std::bit_cast<u32>(61.0f))});
     }},
    {"a glide that is not a time",
     [](HandProgram& p) {
         p.header.features = kFeaturePlayModes;
         prepend(p, {instr(Instr::PlayMode, 1, 0, std::bit_cast<u32>(NAN))});
     }},
    {"a play mode in the conductor",
     [](HandProgram& p) {
         p.header.features = kFeaturePlayModes;
         p.code.insert(p.code.end() - 1, instr(Instr::PlayMode, 1, 0, 0));
         p.header.conductor_length = 2;
     }},
    {"a mix change in the conductor",
     [](HandProgram& p) {
         p.mix_init = {1.0f};
         p.code.insert(p.code.end() - 1, instr(Instr::SetMix, 0, 0, 0));
         p.header.conductor_length = 2;
     }},
};

}  // namespace

TEST(Rules, EveryPatchRuleRefusesItsCase) {
    for (const PatchCase& c : kPatchCases) {
        SCOPED_TRACE(c.name);
        Hand hand;
        c.change(hand.patch);
        EXPECT_EQ(load_error(hand.bytes()), LoadError::BadPatch);
    }
}

TEST(Rules, EveryProgramRuleRefusesItsCase) {
    for (const ProgramCase& c : kProgramCases) {
        SCOPED_TRACE(c.name);
        Hand hand;
        hand.program = minimal_program(0);
        hand.fresh_program = false;
        c.change(hand.program);
        EXPECT_EQ(load_error(hand.bytes()), LoadError::BadProgram);
    }
}

// A Sample2 over a table of these rows, with the asset at ref 0 and the table at ref 1.
LoadError zone_error(std::vector<float> rows) {
    compiler::detail::Writer table, sound;
    table.put(TableHeader{static_cast<u32>(rows.size()), 0});
    rows.push_back(0.0f);
    table.put_all(rows);
    AssetHeader a{};
    a.encoding = static_cast<u8>(AssetEncoding::F32);
    a.channels = 1;
    a.root_key = 60;
    a.native_rate = kRate;
    a.frames = 1;
    sound.put(a);
    sound.put_all(std::vector<float>(2, 0.0f));
    Hand hand;
    hand.extra = {compiler::detail::make_chunk(ChunkKind::Asset, std::move(sound.bytes)),
                  compiler::detail::make_chunk(ChunkKind::Table, std::move(table.bytes))};
    hand.patch.refs = {hand.extra[0].hash, hand.extra[1].hash};
    hand.patch.header.buffers = 2;
    hand.patch.consts = {60.0f, 0.0f};
    WireStep step{};
    step.op = static_cast<u8>(Op::Sample2);
    step.resource = 1;
    step.out[0] = operand(Bank::Buffer, 0);
    step.out[1] = operand(Bank::Buffer, 1);
    step.in[0] = operand(Bank::Const, 0);
    step.in[1] = operand(Bank::Const, 1);
    hand.patch.voice = {step};
    return load_error(hand.bytes());
}

TEST(Rules, AZoneTableIsCheckedForTheStepThatUsesIt) {
    const std::vector<float> good = {0, 127, 0, 127, 0, 60.5f, 0, 0};
    const std::vector<float> padding = {1, 0, 0, 0, 0, 0, 0, 0};
    EXPECT_EQ(zone_error(good), LoadError::None);

    std::vector<float> two = good;
    two.insert(two.end(), padding.begin(), padding.end());
    EXPECT_EQ(zone_error(two), LoadError::None);

    EXPECT_EQ(zone_error({0, 127, 0, 127}), LoadError::BadPatch) << "shorter than a row";
    std::vector<float> many;
    for (u32 i = 0; i < 2 * kMaxZones; ++i) many.insert(many.end(), good.begin(), good.end());
    EXPECT_EQ(zone_error(many), LoadError::BadPatch) << "too many rows";

    const auto with = [&](u32 field, float value) {
        std::vector<float> row = good;
        row[field] = value;
        return zone_error(row);
    };
    EXPECT_EQ(with(kZoneHighKey, 128), LoadError::BadPatch);
    EXPECT_EQ(with(kZoneHighKey, 60.5f), LoadError::BadPatch);
    EXPECT_EQ(with(kZoneHighVelocity, 128), LoadError::BadPatch);
    EXPECT_EQ(with(kZoneLowVelocity, -1), LoadError::BadPatch);
    EXPECT_EQ(with(kZoneRef, 1), LoadError::BadPatch) << "the table itself, which is not a recording";
    EXPECT_EQ(with(kZoneRef, 2), LoadError::BadPatch);
    EXPECT_EQ(with(kZoneRef, 0.5f), LoadError::BadPatch);
    EXPECT_EQ(with(kZoneRoot, 127.5f), LoadError::BadPatch);
    EXPECT_EQ(with(kZoneRoot + 1, 1), LoadError::BadPatch);
    EXPECT_EQ(with(kZoneFields - 1, 1), LoadError::BadPatch);

    std::vector<float> velocities = good;
    velocities[kZoneLowVelocity] = 100;
    velocities[kZoneHighVelocity] = 50;
    EXPECT_EQ(zone_error(velocities), LoadError::BadPatch);
    std::vector<float> other_padding = padding;
    other_padding[kZoneLowKey] = 2;
    EXPECT_EQ(zone_error(other_padding), LoadError::BadPatch);
    other_padding = padding;
    other_padding[kZoneRef] = 1;
    EXPECT_EQ(zone_error(other_padding), LoadError::BadPatch);
}

// The cases above break one rule each, which proves nothing unless the same shape loads without it.
TEST(Rules, TheNewInstructionsLoadWhenNothingIsWrong) {
    const auto load_with = [](u32 features, std::initializer_list<Instruction> code) {
        Hand hand;
        hand.program = minimal_program(0);
        hand.fresh_program = false;
        hand.program.mix_init = {1.0f};
        hand.program.header.features = features;
        prepend(hand.program, code);
        return load_error(hand.bytes());
    };
    const u32 half = std::bit_cast<u32>(0.5f);
    EXPECT_EQ(load_with(0, {instr(Instr::SetMix, 0, 0, half)}), LoadError::None);
    EXPECT_EQ(load_with(kFeatureMixRamps, {instr(Instr::RampMix, 0, 0, half), instr(Instr::RampArg, 0, 0, 1)}),
              LoadError::None);
    EXPECT_EQ(load_with(kFeaturePlayModes, {instr(Instr::PlayMode, 2, 2, half)}), LoadError::None);
    EXPECT_EQ(load_with(kFeaturePlayModes, {instr(Instr::PlayMode, 0, 0, half)}), LoadError::None);
}

TEST(Rules, AnImageMustDeclareTheRevisionOfItsInstructions) {
    Hand hand;
    hand.program = minimal_program(0);
    hand.fresh_program = false;
    hand.program.mix_init = {1.0f};
    prepend(hand.program, {instr(Instr::SetMix, 0, 0, std::bit_cast<u32>(0.5f))});
    const auto good = hand.bytes();
    EXPECT_EQ(load_error(good), LoadError::None);
    const u32 older = 3;
    EXPECT_EQ(load_error(with_manifest(good, offsetof(ManifestHeader, revision), &older, 4)), LoadError::BadProgram);
}

TEST(Rules, ReservedTableAndAssetFieldsMustBeZero) {
    const auto table = [](u32 reserved) {
        compiler::detail::Writer w;
        w.put(TableHeader{2, reserved});
        w.put_all(std::vector<float>(3, 0.0f));
        Hand hand;
        hand.extra = {compiler::detail::make_chunk(ChunkKind::Table, std::move(w.bytes))};
        return hand.bytes();
    };
    EXPECT_EQ(load_error(table(0)), LoadError::None);
    EXPECT_EQ(load_error(table(1)), LoadError::BadTable);

    const auto asset = [](u8 flags) {
        compiler::detail::Writer w;
        AssetHeader h{};
        h.channels = 1;
        h.flags = flags;
        h.native_rate = kRate;
        h.frames = 1;
        w.put(h);
        w.put(std::int16_t{0});
        w.put(std::int16_t{0});
        Hand hand;
        hand.extra = {compiler::detail::make_chunk(ChunkKind::Asset, std::move(w.bytes))};
        return hand.bytes();
    };
    EXPECT_EQ(load_error(asset(0)), LoadError::None);
    EXPECT_EQ(load_error(asset(1)), LoadError::BadAsset);
}

TEST(Rules, ACallCountCannotMakeValidationQuadratic) {
    // A clip's slot count is stated and checked once, so a million Calls of a million-instruction clip stay linear.
    Hand hand;
    hand.program = minimal_program(0);
    hand.fresh_program = false;
    HandProgram& p = hand.program;
    const u32 count = 1u << 20;
    p.code.assign(count, instr(Instr::Wait, 0, 0, 0));
    p.code.push_back(instr(Instr::Wait, 0, 0, 1));
    const u32 clip_length = static_cast<u32>(p.code.size());
    p.clips = {ClipDesc{0, clip_length, 1, 0}};
    p.tracks[0].stream_begin = clip_length;
    p.tracks[0].stream_length = count + 1;
    p.code.insert(p.code.end(), count, instr(Instr::Call, 0, 0, 1));
    p.code.push_back(instr(Instr::End, 0, 0, 0));
    p.header.conductor_begin = static_cast<u32>(p.code.size());
    p.code.push_back(instr(Instr::End, 0, 0, 0));
    p.header.length_ticks = count;
    EXPECT_EQ(load_error(hand.bytes()), LoadError::BadProgram) << "and it unrolls past the limit, so it is refused";
}

TEST_F(LoaderFixture, AThinImageLoadsOnAReceiverHoldingItsPatches) {
    const json project = demo();
    const auto full = compile_image(project);
    Bytes first(full.image);
    Loader loader(table);
    ASSERT_EQ(load_all(loader, first.span()), LoadStatus::Ready);

    json thin = project;
    thin["omit"] = json::array();
    for (const json& c : full.report.at("chunks")) {
        if (c.at("kind") != "program") thin["omit"].push_back(c.at("hash"));
    }
    const auto result = compile_image(thin);
    EXPECT_LT(result.image.size(), full.image.size() / 2);
    Bytes second(result.image);
    Loader again(table);
    EXPECT_EQ(load_all(again, second.span()), LoadStatus::Ready);
}

TEST_F(LoaderFixture, AThinImageFailsCleanlyOnAReceiverWithoutThem) {
    json project = demo();
    const auto full = compile_image(project);
    project["omit"] = json::array();
    for (const json& c : full.report.at("chunks")) {
        if (c.at("kind") == "patch") project["omit"].push_back(c.at("hash"));
    }
    Bytes image(compile_image(project).image);
    Loader loader(table);
    EXPECT_EQ(load_all(loader, image.span()), LoadStatus::Failed);
    EXPECT_EQ(loader.error(), LoadError::MissingChunk);
    EXPECT_EQ(table.size(), 0u);
}

TEST_F(LoaderFixture, AnEditedSharedPatchCannotSlipThroughAThinImage) {
    json project = demo();
    const auto full = compile_image(project);
    Bytes first(full.image);
    Loader loader(table);
    ASSERT_EQ(load_all(loader, first.span()), LoadStatus::Ready);

    // The omit list is what the receiver had. The patch has since changed, so its new hash is not on it.
    json edited = project;
    edited["patches"]["lead"]["graph"]["nodes"].push_back({{"id", 40}, {"type", "noise"}});
    edited["patches"]["lead"]["graph"]["nodes"].push_back({{"id", 41}, {"type", "add"}});
    edited["patches"]["lead"]["graph"]["edges"].push_back({{"from", 16}, {"to", 41}, {"input", "a"}});
    edited["patches"]["lead"]["graph"]["edges"].push_back({{"from", 40}, {"to", 41}, {"input", "b"}});
    for (json& e : edited["patches"]["lead"]["graph"]["edges"]) {
        if (e.at("to") == 19 && e.at("input") == "a") e["from"] = 41;
    }
    const auto changed = compile_image(edited);
    edited["omit"] = json::array();
    for (const json& c : changed.report.at("chunks")) {
        const bool known = table.find(std::stoull(c.at("hash").get<std::string>(), nullptr, 16)) != nullptr;
        if (known || c.at("kind") == "patch") edited["omit"].push_back(c.at("hash"));
    }
    Bytes thin(compile_image(edited).image);
    const u32 before = table.size();
    Loader again(table);
    EXPECT_EQ(load_all(again, thin.span()), LoadStatus::Failed);
    EXPECT_EQ(again.error(), LoadError::MissingChunk);
    EXPECT_EQ(table.size(), before);
}

TEST(Memory, DelayLinesTooLongToCountStillCountAsTooLong) {
    // 4.3 billion floats, which wrapped a 32-bit total, so a patch could get past the memory check.
    HandPatch patch = minimal_patch();
    patch.delays.assign(1500, 60.0f);
    const compiler::Chunk patch_chunk = patch.chunk();
    const compiler::Chunk program_chunk = minimal_program(patch_chunk.hash).chunk();
    std::vector<ChunkRef> storage(4);
    ChunkTable table(storage);
    ASSERT_TRUE(table.add({patch_chunk.hash, patch_chunk.payload.data(), static_cast<u32>(patch_chunk.payload.size()),
                           static_cast<u8>(ChunkKind::Patch)}));
    ASSERT_TRUE(table.add({program_chunk.hash, program_chunk.payload.data(),
                           static_cast<u32>(program_chunk.payload.size()), static_cast<u8>(ChunkKind::Program)}));
    const auto need = Synth<kStereo>::bytes_required(table, program_chunk.hash, kRate);
    EXPECT_GE(need.bulk, 1500ull * 60 * 48000 * sizeof(float));
}
