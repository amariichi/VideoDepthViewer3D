#!/bin/bash

FRONTEND_ARGS=()
case "${1:-}" in
    "")
        ;;
    --lan)
        FRONTEND_ARGS=(-- --host 0.0.0.0)
        ;;
    *)
        echo "Usage: ./start.sh [--lan]"
        exit 2
        ;;
esac

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

uv run --locked --extra inference python3 scripts/run_backend.py --reload &
BACKEND_PID=$!

# Start Frontend
if [ "${1:-}" = "--lan" ]; then
    echo "Starting Frontend for trusted LAN access..."
else
    echo "Starting Frontend..."
fi
cd webapp
if [ ! -d "node_modules" ]; then
    echo "Installing frontend dependencies..."
    npm ci
fi
npm run dev "${FRONTEND_ARGS[@]}" &
FRONTEND_PID=$!

# Wait for both processes
wait $BACKEND_PID $FRONTEND_PID
