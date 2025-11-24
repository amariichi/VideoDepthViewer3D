#!/bin/bash

# Function to kill all child processes on exit
cleanup() {
    echo "Stopping VideoDepthViewer3D..."
    kill $(jobs -p) 2>/dev/null
    exit
}

# Trap SIGINT (Ctrl+C) and call cleanup
trap cleanup SIGINT

# Start Backend
echo "Starting Backend..."
# Use default high-performance settings if not set
export VIDEO_DEPTH_INFER_WORKERS=${VIDEO_DEPTH_INFER_WORKERS:-3}
export VIDEO_DEPTH_DOWNSAMPLE=${VIDEO_DEPTH_DOWNSAMPLE:-1}
export UV_CACHE_DIR=${UV_CACHE_DIR:-.uv-cache}
export DA3_LOG_LEVEL=WARN

uv run python3 scripts/run_backend.py --reload &
BACKEND_PID=$!

# Start Frontend
echo "Starting Frontend..."
cd webapp
if [ ! -d "node_modules" ]; then
    echo "Installing frontend dependencies..."
    npm install
fi
npm run dev &
FRONTEND_PID=$!

# Wait for both processes
wait $BACKEND_PID $FRONTEND_PID
