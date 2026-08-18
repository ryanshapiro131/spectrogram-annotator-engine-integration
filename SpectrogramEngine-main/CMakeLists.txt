cmake_minimum_required(VERSION 3.15)
project(SpectrogramEngine LANGUAGES C CXX)

# ---- Standards ----------------------------------------------------------
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Default to an optimized build (the engine is compute-heavy). Users can still
# override with -DCMAKE_BUILD_TYPE=Debug.
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

set(THIRD_PARTY ${CMAKE_CURRENT_SOURCE_DIR}/third_party)

# ---- libspectrogram: headless engine core (no UI/graphics deps) ---------
find_package(Threads REQUIRED)

add_library(spectrogram
  src/engine/AudioFile.cpp
  src/engine/Stft.cpp
  src/engine/Colormap.cpp
  src/engine/SpectrogramImage.cpp
  src/engine/TileEncode.cpp
  src/engine/Manifest.cpp
  src/engine/TilePyramid.cpp
  src/engine/StreamingEngine.cpp
  src/engine/Parallel.cpp
  src/engine/third_party_impl.cpp
  third_party/pffft.c
)

target_link_libraries(spectrogram PUBLIC Threads::Threads)

target_include_directories(spectrogram PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/src/engine
  ${THIRD_PARTY}
)

# pffft.c is C99; it auto-selects NEON on Apple Silicon / SSE on x86.
set_source_files_properties(third_party/pffft.c PROPERTIES LANGUAGE C)

# Keep the vendored single-header libs from drowning us in their own warnings.
if(CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
  set_source_files_properties(third_party/pffft.c
    PROPERTIES COMPILE_OPTIONS "-Wno-unused-function;-Wno-unused-variable")
endif()

# ---- spectrogram-engine: thin CLI --------------------------------------
add_executable(spectrogram-engine src/cli/main.cpp)
target_link_libraries(spectrogram-engine PRIVATE spectrogram)

# std::filesystem needs no extra lib on Apple Clang / modern libstdc++, but be
# explicit for older GCC on the eventual Linux server.
if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU" AND CMAKE_CXX_COMPILER_VERSION VERSION_LESS 9.0)
  target_link_libraries(spectrogram-engine PRIVATE stdc++fs)
endif()

# Cross-window amplitude-consistency self-test (Phase G / STEP 7a).
add_executable(amp-selftest tools/amp_selftest.cpp)
target_link_libraries(amp-selftest PRIVATE spectrogram)
