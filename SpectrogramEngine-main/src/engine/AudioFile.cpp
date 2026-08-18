#include "AudioFile.h"

// Declarations only; implementations live in third_party_impl.cpp.
#include "dr_flac.h"
#include "dr_mp3.h"
#include "dr_wav.h"

#include <cctype>

namespace spectro {

namespace {
std::string toLower(std::string s) {
    for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}
bool endsWith(const std::string& s, const std::string& suffix) {
    return s.size() >= suffix.size() &&
           s.compare(s.size() - suffix.size(), suffix.size(), suffix) == 0;
}

enum class Codec { Wav, Mp3, Flac };

// Frees an interleaved float buffer with the allocator matching the codec.
void freeInterleaved(Codec codec, float* p) {
    switch (codec) {
        case Codec::Wav:  drwav_free(p, nullptr);  break;
        case Codec::Mp3:  drmp3_free(p, nullptr);  break;
        case Codec::Flac: drflac_free(p, nullptr); break;
    }
}

bool codecFromPath(const std::string& lowerPath, Codec& codec) {
    if (endsWith(lowerPath, ".wav")) { codec = Codec::Wav; return true; }
    if (endsWith(lowerPath, ".mp3")) { codec = Codec::Mp3; return true; }
    if (endsWith(lowerPath, ".flac")) { codec = Codec::Flac; return true; }
    return false;
}

// Streaming decoder state (opaque to callers via AudioReader::impl).
struct ReaderImpl {
    Codec codec;
    unsigned channels = 0;
    drwav wav{};
    drmp3 mp3{};
    drflac* flac = nullptr;
    std::vector<float> scratch;  // interleaved read buffer
};
} // namespace

bool loadAudioMono(const std::string& path, AudioData& out, std::string& err) {
    const std::string lp = toLower(path);

    Codec codec;
    if (endsWith(lp, ".wav")) {
        codec = Codec::Wav;
    } else if (endsWith(lp, ".mp3")) {
        codec = Codec::Mp3;
    } else if (endsWith(lp, ".flac")) {
        codec = Codec::Flac;
    } else {
        err = "unsupported audio format (supported: .wav, .mp3, .flac). Got: " + path;
        return false;
    }

    // Each decoder reads the whole file to interleaved float32
    // (channels * totalFrames values) and reports channels + sample rate.
    unsigned int channels = 0;
    unsigned int sampleRate = 0;
    unsigned long long totalFrames = 0;
    float* interleaved = nullptr;

    switch (codec) {
        case Codec::Wav: {
            drwav_uint64 frames = 0;
            interleaved = drwav_open_file_and_read_pcm_frames_f32(
                path.c_str(), &channels, &sampleRate, &frames, nullptr);
            totalFrames = frames;
            break;
        }
        case Codec::Mp3: {
            drmp3_config cfg{};
            drmp3_uint64 frames = 0;
            interleaved = drmp3_open_file_and_read_pcm_frames_f32(
                path.c_str(), &cfg, &frames, nullptr);
            channels = cfg.channels;
            sampleRate = cfg.sampleRate;
            totalFrames = frames;
            break;
        }
        case Codec::Flac: {
            drflac_uint64 frames = 0;
            interleaved = drflac_open_file_and_read_pcm_frames_f32(
                path.c_str(), &channels, &sampleRate, &frames, nullptr);
            totalFrames = frames;
            break;
        }
    }

    if (!interleaved) {
        err = "failed to open/decode audio: " + path;
        return false;
    }
    if (sampleRate == 0 || channels == 0) {
        freeInterleaved(codec, interleaved);
        err = "audio has invalid header (sampleRate/channels == 0): " + path;
        return false;
    }

    out.sampleRate = sampleRate;
    out.numFrames = totalFrames;
    out.sourceChannels = channels;
    out.samples.resize(static_cast<size_t>(totalFrames));

    if (channels == 1) {
        for (unsigned long long i = 0; i < totalFrames; ++i) {
            out.samples[static_cast<size_t>(i)] = interleaved[i];
        }
    } else {
        // Mix down to mono by averaging channels.
        const float inv = 1.0f / static_cast<float>(channels);
        for (unsigned long long i = 0; i < totalFrames; ++i) {
            float acc = 0.0f;
            for (unsigned int c = 0; c < channels; ++c) {
                acc += interleaved[i * channels + c];
            }
            out.samples[static_cast<size_t>(i)] = acc * inv;
        }
    }

    freeInterleaved(codec, interleaved);
    return true;
}

bool openAudioReader(const std::string& path, AudioReader& reader, std::string& err) {
    Codec codec;
    if (!codecFromPath(toLower(path), codec)) {
        err = "unsupported audio format (supported: .wav, .mp3, .flac). Got: " + path;
        return false;
    }

    auto* impl = new ReaderImpl();
    impl->codec = codec;

    switch (codec) {
        case Codec::Wav: {
            if (!drwav_init_file(&impl->wav, path.c_str(), nullptr)) {
                delete impl;
                err = "failed to open WAV: " + path;
                return false;
            }
            reader.sampleRate = impl->wav.sampleRate;
            reader.channels = impl->wav.channels;
            reader.totalFrames = impl->wav.totalPCMFrameCount;
            break;
        }
        case Codec::Mp3: {
            if (!drmp3_init_file(&impl->mp3, path.c_str(), nullptr)) {
                delete impl;
                err = "failed to open MP3: " + path;
                return false;
            }
            reader.sampleRate = impl->mp3.sampleRate;
            reader.channels = impl->mp3.channels;
            // MP3 has no header frame count; scan for it, then reopen so the real
            // read starts cleanly at frame 0 (identical to a bulk decode).
            reader.totalFrames = drmp3_get_pcm_frame_count(&impl->mp3);
            drmp3_uninit(&impl->mp3);
            if (!drmp3_init_file(&impl->mp3, path.c_str(), nullptr)) {
                delete impl;
                err = "failed to reopen MP3: " + path;
                return false;
            }
            break;
        }
        case Codec::Flac: {
            impl->flac = drflac_open_file(path.c_str(), nullptr);
            if (!impl->flac) {
                delete impl;
                err = "failed to open FLAC: " + path;
                return false;
            }
            reader.sampleRate = impl->flac->sampleRate;
            reader.channels = impl->flac->channels;
            reader.totalFrames = impl->flac->totalPCMFrameCount;
            break;
        }
    }

    impl->channels = reader.channels;
    reader.impl = impl;

    if (reader.sampleRate == 0 || reader.channels == 0) {
        closeAudioReader(reader);  // properly closes the decoder handle + frees impl
        err = "audio has invalid header (sampleRate/channels == 0): " + path;
        return false;
    }
    return true;
}

int64_t readAudioMono(AudioReader& reader, float* dst, int64_t maxFrames) {
    if (!reader.impl || maxFrames <= 0) return 0;
    auto* impl = static_cast<ReaderImpl*>(reader.impl);
    const unsigned ch = impl->channels;

    if (ch == 1) {
        // Mono source: read straight into dst.
        switch (impl->codec) {
            case Codec::Wav:  return static_cast<int64_t>(drwav_read_pcm_frames_f32(&impl->wav, maxFrames, dst));
            case Codec::Mp3:  return static_cast<int64_t>(drmp3_read_pcm_frames_f32(&impl->mp3, maxFrames, dst));
            case Codec::Flac: return static_cast<int64_t>(drflac_read_pcm_frames_f32(impl->flac, maxFrames, dst));
        }
        return 0;
    }

    // Multi-channel: read interleaved into scratch, then average to mono.
    const size_t need = static_cast<size_t>(maxFrames) * ch;
    if (impl->scratch.size() < need) impl->scratch.resize(need);
    float* buf = impl->scratch.data();

    int64_t framesRead = 0;
    switch (impl->codec) {
        case Codec::Wav:  framesRead = static_cast<int64_t>(drwav_read_pcm_frames_f32(&impl->wav, maxFrames, buf)); break;
        case Codec::Mp3:  framesRead = static_cast<int64_t>(drmp3_read_pcm_frames_f32(&impl->mp3, maxFrames, buf)); break;
        case Codec::Flac: framesRead = static_cast<int64_t>(drflac_read_pcm_frames_f32(impl->flac, maxFrames, buf)); break;
    }

    const float inv = 1.0f / static_cast<float>(ch);
    for (int64_t i = 0; i < framesRead; ++i) {
        float acc = 0.0f;
        for (unsigned c = 0; c < ch; ++c) acc += buf[i * ch + c];
        dst[i] = acc * inv;
    }
    return framesRead;
}

void closeAudioReader(AudioReader& reader) {
    if (!reader.impl) return;
    auto* impl = static_cast<ReaderImpl*>(reader.impl);
    switch (impl->codec) {
        case Codec::Wav:  drwav_uninit(&impl->wav); break;
        case Codec::Mp3:  drmp3_uninit(&impl->mp3); break;
        case Codec::Flac: if (impl->flac) drflac_close(impl->flac); break;
    }
    delete impl;
    reader.impl = nullptr;
}

} // namespace spectro
