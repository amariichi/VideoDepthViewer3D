import av
import sys

def main():
    if len(sys.argv) < 2:
        print("Usage: python inspect_gop.py <video_path>")
        return

    path = sys.argv[1]
    container = av.open(path)
    stream = container.streams.video[0]
    
    print(f"Inspecting {path}")
    print(f"Stream duration: {float(stream.duration * stream.time_base):.2f}s")
    print(f"FPS: {stream.average_rate}")
    
    print("Keyframes:")
    for packet in container.demux(stream):
        if packet.is_keyframe:
            print(f"PTS: {packet.pts}, Time: {float(packet.pts * stream.time_base):.3f}s")

if __name__ == "__main__":
    main()
