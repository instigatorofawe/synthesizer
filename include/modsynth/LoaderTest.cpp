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

LoadStatus load_all(Loader& l, ByteSpan image, u32 budget = 1 << 20) {
    l.begin(image);
    while (l.step(budget) == LoadStatus::Working) {
    }
    return l.status();
}

// Rewrites a chunk's stored hash and the manifest's, so a corruption gets past the hash and reaches the validator.
void reseal(std::byte* image, std::size_t chunk_at) {
    ChunkHeader ch = load<ChunkHeader>(image + chunk_at);
    const std::byte* body = image + chunk_at + sizeof(ChunkHeader);
    const u64 old_hash = ch.hash;
    ch.hash = hash_bytes(hash_seed(static_cast<ChunkKind>(ch.kind)), body, ch.size);
    std::memcpy(image + chunk_at, &ch, sizeof ch);

    ChunkHeader mh = load<ChunkHeader>(image);
    std::byte* manifest = image + sizeof(ChunkHeader);
    const ManifestHeader header = load<ManifestHeader>(manifest);
    for (u32 i = 0; i < header.entries; ++i) {
        std::byte* at = manifest + sizeof(ManifestHeader) + i * sizeof(ManifestEntry);
        ManifestEntry e = load<ManifestEntry>(at);
        if (e.hash == old_hash) {
            e.hash = ch.hash;
            std::memcpy(at, &e, sizeof e);
        }
    }
    mh.hash = hash_bytes(hash_seed(ChunkKind::Manifest), manifest, mh.size);
    std::memcpy(image, &mh, sizeof mh);
}

std::size_t find_chunk(const std::byte* image, std::size_t size, ChunkKind kind) {
    std::size_t at = 0;
    while (at + sizeof(ChunkHeader) <= size) {
        const ChunkHeader h = load<ChunkHeader>(image + at);
        if (h.kind == static_cast<u8>(kind)) return at;
        at += sizeof(ChunkHeader) + (h.size + kChunkAlign - 1) / kChunkAlign * kChunkAlign;
    }
    return 0;
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

TEST_F(LoaderFixture, EveryFlippedByteOutsidePaddingIsCaught) {
    const auto original = compile_demo();

    // Padding between chunks is the only thing nothing reads.
    std::vector<bool> padding(original.size(), false);
    for (std::size_t at = 0; at < original.size();) {
        const ChunkHeader h = load<ChunkHeader>(original.data() + at);
        const std::size_t end = at + sizeof(ChunkHeader) + h.size;
        const std::size_t next = at + sizeof(ChunkHeader) + (h.size + kChunkAlign - 1) / kChunkAlign * kChunkAlign;
        for (std::size_t i = end; i < next; ++i) padding[i] = true;
        at = next;
    }

    for (std::size_t at = 0; at < original.size(); at += at < 4096 ? 1 : 97) {
        Bytes image(original);
        image.data()[at] ^= std::byte{0x40};
        std::vector<ChunkRef> s(kMaxChunks);
        ChunkTable t(s);
        Loader loader(t);
        const LoadStatus status = load_all(loader, image.span());
        if (padding[at]) {
            EXPECT_EQ(status, LoadStatus::Ready) << at;
        } else {
            EXPECT_EQ(status, LoadStatus::Failed) << at;
            EXPECT_EQ(t.size(), 0u) << "a failed image must leave nothing behind";
        }
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
    Bytes image(compile_demo());
    const std::size_t at = find_chunk(image.data(), image.size, ChunkKind::Program);
    ProgramHeader h = load<ProgramHeader>(image.data() + at + sizeof(ChunkHeader));
    h.code = 0x20000000;  // times 8 is 2^32, which wraps to 0 on 32-bit
    std::memcpy(image.data() + at + sizeof(ChunkHeader), &h, sizeof h);
    reseal(image.data(), at);
    Loader loader(table);
    EXPECT_EQ(load_all(loader, image.span()), LoadStatus::Failed);
    EXPECT_EQ(loader.error(), LoadError::BadProgram);
}

TEST_F(LoaderFixture, RejectsAVoiceStepWritingAGlobalScalar) {
    Bytes image(compile_demo());
    const std::size_t at = find_chunk(image.data(), image.size, ChunkKind::Patch);
    const ChunkHeader ch = load<ChunkHeader>(image.data() + at);
    const std::byte* body = image.data() + at + sizeof(ChunkHeader);
    PatchView v;
    ASSERT_TRUE(parse_patch({body, ch.size}, v));
    ASSERT_GT(v.h.voice_steps, 0);
    WireStep s = v.step(v.h.control_steps);
    s.op = static_cast<u8>(Op::KAdd);
    s.out[0] = operand(Bank::Global, 0);
    s.in[0] = s.in[1] = operand(Bank::Voice, kScalarNote);
    std::memcpy(image.data() + at + sizeof(ChunkHeader) + v.steps + v.h.control_steps * sizeof(WireStep), &s, sizeof s);
    reseal(image.data(), at);
    Loader loader(table);
    EXPECT_EQ(load_all(loader, image.span()), LoadStatus::Failed);
    EXPECT_EQ(loader.error(), LoadError::BadPatch);
}

TEST_F(LoaderFixture, RejectsAStepReadingAnUnwrittenBuffer) {
    Bytes image(compile_demo());
    const std::size_t at = find_chunk(image.data(), image.size, ChunkKind::Patch);
    const ChunkHeader ch = load<ChunkHeader>(image.data() + at);
    const std::byte* body = image.data() + at + sizeof(ChunkHeader);
    PatchView v;
    ASSERT_TRUE(parse_patch({body, ch.size}, v));
    WireStep s{};
    s.op = static_cast<u8>(Op::Mul);
    s.out[0] = operand(Bank::Buffer, 0);
    s.in[0] = s.in[1] = operand(Bank::Buffer, static_cast<u16>(v.h.buffers - 1));
    std::memcpy(image.data() + at + sizeof(ChunkHeader) + v.steps + v.h.control_steps * sizeof(WireStep), &s, sizeof s);
    reseal(image.data(), at);
    Loader loader(table);
    EXPECT_EQ(load_all(loader, image.span()), LoadStatus::Failed);
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
