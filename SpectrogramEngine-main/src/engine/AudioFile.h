#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace spectro {

// Decoded audio, mixed down to a single mono channel of float32 samples
// (nominal range [-1, 1]). The native sample rate is preserved (no resampling).
struct AudioData {
    std::vector<float> samples;  // mono samples
    uint32_t sampleRate = 0;
    uint64_t numFrames = 0;      // number of mono samples (== samples.size())
    uint32_t sourceChannels = 0; // channel count of the source file
};

// Loads an entire audio file and mixes it to mono, dispatching on the file
// extension: .wav (dr_wav), .mp3 (dr_mp3), .flac (dr_flac). Native rate kept.
// Used by the whole-file (non-streaming) path. Returns false and fills `err`.
bool loadAudioMono(const std::string& path, AudioData& out, std::string& err);

// --- Incremental (streaming) decode -------------------------------------
// Opens a file for chunked reading so the whole signal never has to live in RAM.
// After openAudioReader, sampleRate/channels/totalFrames are populated. Read mono
// chunks with readAudioMono until it returns 0 (EOF), then closeAudioReader.
struct AudioReader {
    uint32_t sampleRate = 0;
    uint32_t channels = 0;
    uint64_t totalFrames = 0;  // total PCM frames (mono samples)
    void* impl = nullptr;      // opaque decoder state
};

bool openAudioReader(const std::string& path, AudioReader& reader, std::string& err);

// Reads up to maxFrames PCM frames, mixes to mono into dst (must hold >= maxFrames
// floats), and returns the number of frames actually read (0 == EOF).
int64_t readAudioMono(AudioReader& reader, float* dst, int64_t maxFrames);

void closeAudioReader(AudioReader& reader);

} // namespace spectro
