#!/bin/bash
# One command: build the engine (first run only), generate spectrogram tiles for
# an audio file, write a metrics report, serve the viewer, and print the URL.
#
# Usage:  ./run.sh path/to/audio.(wav|mp3|flac)

REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO" || { echo "Error: cannot enter repo directory."; exit 1; }

# --- 0. usage --------------------------------------------------------------
if [ $# -lt 1 ]; then
  echo "Usage: ./run.sh path/to/audio.(wav|mp3|flac) [engine options...]"
  echo "Example: ./run.sh audio_test_files/song.wav"
  echo "         ./run.sh song.wav --window-sizes 512,1024,4096 --freq-scale log"
  exit 0
fi

AUDIO="$1"
shift                          # remaining args are forwarded to the engine
if [ ! -f "$AUDIO" ]; then
  echo "Error: file not found: $AUDIO"
  exit 1
fi

# --- 1. build if needed ----------------------------------------------------
BIN="build/spectrogram-engine"
if [ ! -x "$BIN" ]; then
  echo "Building engine (first run only)..."
  if ! cmake -S . -B build -DCMAKE_BUILD_TYPE=Release >/tmp/spec_build.log 2>&1 \
     || ! cmake --build build -j >>/tmp/spec_build.log 2>&1; then
    echo "Error: build failed. Last lines of /tmp/spec_build.log:"
    tail -n 8 /tmp/spec_build.log
    exit 1
  fi
  echo "Build OK."
fi

# --- 2. run the engine -----------------------------------------------------
BASE="$(basename "$AUDIO")"
NAME="${BASE%.*}"          # strip extension
NAME="${NAME// /_}"        # spaces -> underscores (URL-safe folder name)
[ -z "$NAME" ] && NAME="output"
OUTDIR="out/$NAME"
mkdir -p out

echo "Processing '$AUDIO' -> $OUTDIR/ ..."
echo ""
if ! "$BIN" "$AUDIO" "$OUTDIR" "$@"; then   # "$@" = any extra engine flags
  echo "Error: could not process '$AUDIO' (unsupported or corrupt file?)."
  exit 1
fi

# --- 3. serve the viewer (background, non-blocking) ------------------------
VIEWER="http://127.0.0.1:8000/viewer/index.html"
if curl -fsS -o /dev/null "$VIEWER" 2>/dev/null; then
  echo "(static server already running on port 8000)"
else
  nohup python3 -m http.server 8000 --bind 127.0.0.1 >/tmp/spec_server.log 2>&1 &
  curl --retry 20 --retry-connrefused --retry-delay 0 -fsS -o /dev/null "$VIEWER" 2>/dev/null
  if ! curl -fsS -o /dev/null "$VIEWER" 2>/dev/null; then
    echo "Warning: could not start the server on port 8000 (is the port in use?)."
    echo "Start it manually from this folder:  python3 -m http.server 8000"
  fi
fi

# --- 4. print the URL ------------------------------------------------------
echo ""
echo "Open: http://localhost:8000/viewer/?src=/$OUTDIR/"
