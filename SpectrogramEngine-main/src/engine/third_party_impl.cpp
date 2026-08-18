// Single translation unit that pulls in the implementations of the vendored
// single-header libraries. Keeping the *_IMPLEMENTATION macros isolated here
// means the rest of the engine only includes the headers for declarations.

#define DR_WAV_IMPLEMENTATION
#include "dr_wav.h"

#define DR_MP3_IMPLEMENTATION
#include "dr_mp3.h"

#define DR_FLAC_IMPLEMENTATION
#include "dr_flac.h"

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"
