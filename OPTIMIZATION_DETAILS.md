# VideoDepthViewer3D Optimization Details

[English](#english) | [日本語](#japanese)

---

<a name="english"></a>
## English

This document details the optimization mechanisms implemented in VideoDepthViewer3D to achieve high FPS (~30fps) and low latency depth streaming. The pipeline is designed to maximize GPU utilization while maintaining synchronization with the video playback.

### 1. Pipeline Architecture

The pipeline is divided into distinct stages, each optimized for throughput and latency. Stages A through E run on the **Backend**, while Stage F runs on the **Frontend**.

#### A. Request Queue (Backend Flow Control)
*   **Mechanism:** `DroppingQueue` (Custom implementation)
*   **Logic:** The queue has a fixed size (32). When the frontend sends requests faster than the backend can process, the queue fills up. Instead of blocking or rejecting new requests, the `DroppingQueue` **drops the oldest request** to make room for the new one.
*   **Benefit:** This prevents "death spirals" where the backend wastes resources processing frames that are already seconds old and useless to the client. It ensures the backend always works on the freshest possible data.
*   **Note:** This is a safety mechanism. Primary flow control is handled by the Frontend's `maxInflight` setting (see below).

#### B. Decode Stage (Backend Parallelism)
*   **Bottleneck:** Video decoding (especially high-res MP4) is CPU-intensive and stateful. Seeking (`av.seek`) is slow.
*   **Optimization:** `DecoderPool`
    *   **Parallelism:** Instead of a single decoder, we maintain a pool (default: 4) of `FrameDecoder` instances.
    *   **Smart Scheduling:** When a request for timestamp `T` arrives, the pool checks if any free decoder is currently positioned near `T` (within `STREAM_WINDOW_MS`). If found, it reuses that decoder to stream forward (fast). If not, it picks the least-recently-used decoder and performs a seek (slow).
    *   **Result:** This eliminates the "serial decoding" bottleneck, allowing multiple frames to be decoded simultaneously without blocking the main event loop.

#### C. Inference Stage (Backend Throughput)
*   **Mechanism:** `Depth Anything 3` (Metric)
*   **Optimization:**
    *   **Concurrency:** `VIDEO_DEPTH_INFER_WORKERS` (default: 3, recommended: 4-8). Multiple inference tasks run in parallel on the GPU.
    *   **Resolution:** `VIDEO_DEPTH_PROCESS_RES` (default: 640). Input images are resized before inference. Lowering this (e.g., to 384) linearly reduces GPU load.
    *   **Backpressure:** A semaphore limits the number of concurrent CUDA tasks to prevent OOM (Out of Memory) errors.

#### D. Pack Stage (Backend Data Reduction)
*   **Mechanism:** Quantization & Downsampling
*   **Optimization:**
    *   **Quantization:** Float32 depth values are normalized and quantized to `uint16` (0-65535). This halves the payload size compared to Float32.
    *   **Downsampling:** `VIDEO_DEPTH_DOWNSAMPLE` (default: 1, recommended: 2 or 4). The depth map is resized using nearest-neighbor or linear interpolation before sending.
        *   Factor 2: 1/4 data size.
        *   Factor 4: 1/16 data size.
    *   **Benefit:** Significantly reduces `pack_s` (CPU time) and `ws_send_s` (Network transmission time), which was the primary bottleneck for achieving 30fps.

#### E. Send Stage (Backend Ordering)
*   **Mechanism:** WebSocket Binary Stream
*   **Logic:** The backend uses an `asyncio.Queue` (`send_queue`) to enforce strict ordering. Even if parallel worker #3 finishes before worker #1, the sender waits for #1's result before sending #3.
*   **Benefit:** Guarantees that frames arrive at the client in strictly increasing timestamp order, preventing visual "time travel" artifacts.

#### F. Rendering Stage (Frontend Sync)
*   **Mechanism:** `DepthBuffer` & Flow Control
*   **Optimization:**
    *   **Flow Control (maxInflight):** The frontend limits the number of concurrent requests sent to the backend (default: 8). This acts as the primary throttle to prevent network congestion.
    *   **Jitter Buffer:** The frontend stores incoming frames in a sorted buffer.
    *   **Lead Time:** The client requests frames `depthLeadMs` (default: 2000ms) *ahead* of the current video time. This buffer absorbs network jitter and inference latency spikes.
    *   **Texture Reuse:** The `Three.js` `DataTexture` is allocated once and reused. We only update the underlying buffer (`gl.texSubImage2D`), avoiding Garbage Collection pauses.
    *   **Frontend FPS:** We track the actual number of texture updates per second, providing a true measure of visual smoothness.

### 2. Tuning & Feedback Loop

The system is designed to be tunable based on hardware capabilities.

*   **Telemetry:** The backend collects metrics (`decode_s`, `infer_s`, `queue_wait_s`, `ws_send_s`) and reports them to the frontend.
*   **Automatic Resolution Control (Backend):**
    *   The backend monitors `infer_avg_s` (inference time), `queue_avg_s` (wait time), and `latency_ms` (RTT).
    *   **Downgrade:** If inference > 200ms, queue > 300ms, or RTT > 500ms, the processing resolution is automatically lowered (e.g., 640 -> 512) to recover FPS.
    *   **Upgrade:** If all metrics are healthy (inference < 80ms, etc.), resolution is gradually restored.
*   **Manual Tuning (User):**
    *   **High Latency?** -> Increase `VIDEO_DEPTH_DOWNSAMPLE` or decrease `maxInflight`.
    *   **Low FPS?** -> Increase `VIDEO_DEPTH_INFER_WORKERS` or `maxInflight`.
    *   **Stuttering?** -> Check `QueueWait`. If high, the backend is overloaded (reduce resolution).

---

<a name="japanese"></a>
## 日本語

本ドキュメントでは、VideoDepthViewer3Dにおいて高FPS（約30fps）と低遅延を実現するために実装された最適化の仕組みについて詳細に解説します。このパイプラインは、動画再生との同期を維持しつつ、GPU使用率を最大化するように設計されています。

### 1. パイプラインアーキテクチャ

パイプラインは複数のステージに分かれており、各ステージでスループットと遅延の最適化が行われています。ステージA〜Eは**バックエンド**、ステージFは**フロントエンド**で動作します。

#### A. リクエストキュー (バックエンド フロー制御)
*   **使用技術:** `DroppingQueue` (独自実装)
*   **仕組み:** キューのサイズは固定（32）です。フロントエンドからの要求がバックエンドの処理能力を超えると、キューが一杯になります。この際、新しいリクエストをブロックしたり拒否したりするのではなく、**最も古いリクエストを破棄（ドロップ）** して、新しいリクエストのためのスペースを作ります。
*   **効果:** これにより、バックエンドが「数秒前の（既にクライアントにとって不要な）フレーム」を処理してリソースを無駄にする「デススパイラル」を防ぎます。常に最新のデータを処理することが保証されます。
*   **補足:** これは最終的な安全装置です。日常的な流量制御は、後述するフロントエンドの `maxInflight` 設定によって行われます。

#### B. デコードステージ (バックエンド 並列化)
*   **ボトルネック:** 動画デコード（特に高解像度MP4）はCPU負荷が高く、ステートフルです。シーク処理（`av.seek`）は低速です。
*   **最適化:** `DecoderPool`
    *   **並列化:** 単一のデコーダーではなく、複数の `FrameDecoder` インスタンス（デフォルト: 4）をプールして管理します。
    *   **スマートスケジューリング:** タイムスタンプ `T` のリクエストが来た際、プール内の空きデコーダーが `T` の近く（`STREAM_WINDOW_MS` 以内）にあるかを確認します。あれば、そのデコーダーを再利用して前方へストリーミング（高速）します。なければ、最も長く使われていないデコーダーを選んでシーク（低速）します。
    *   **結果:** これにより「デコード待ち」によるボトルネックが解消され、メインループをブロックすることなく複数のフレームを同時にデコード可能になりました。

#### C. 推論ステージ (バックエンド スループット)
*   **使用技術:** `Depth Anything 3` (Metric)
*   **最適化:**
    *   **並列実行:** `VIDEO_DEPTH_INFER_WORKERS`（デフォルト: 3、推奨: 4-8）。GPU上で複数の推論タスクを並列に実行します。
    *   **解像度制御:** `VIDEO_DEPTH_PROCESS_RES`（デフォルト: 640）。推論前に入力画像をリサイズします。値を下げる（例: 384）と、GPU負荷が線形に減少します。
    *   **バックプレッシャー:** セマフォを用いて同時実行されるCUDAタスク数を制限し、VRAM不足（OOM）を防ぎます。

#### D. パックステージ (バックエンド データ削減)
*   **使用技術:** 量子化 & ダウンサンプリング
*   **最適化:**
    *   **量子化:** Float32の深度値を正規化し、`uint16`（0-65535）に変換します。これによりペイロードサイズが半分になります。
    *   **ダウンサンプリング:** `VIDEO_DEPTH_DOWNSAMPLE`（デフォルト: 1、推奨: 2 または 4）。送信前に深度マップを最近傍または線形補間でリサイズします。
        *   係数 2: データサイズ 1/4
        *   係数 4: データサイズ 1/16
    *   **効果:** `pack_s`（CPU時間）と `ws_send_s`（ネットワーク送信時間）を劇的に削減します。これらは30fps達成のための最大の障壁でした。

#### E. 送信ステージ (バックエンド 順序保証)
*   **使用技術:** WebSocket バイナリストリーム
*   **仕組み:** バックエンドは `asyncio.Queue` (`send_queue`) を使用して厳密な順序を強制します。並列ワーカー#3が#1より先に終わったとしても、送信プロセスは#1の結果が出るまで待機してから送信します。
*   **効果:** クライアントには常にタイムスタンプ順でフレームが届くことが保証され、映像が前後する「タイムトラベル」現象を防ぎます。

#### F. レンダリングステージ (フロントエンド 同期)
*   **使用技術:** `DepthBuffer` & フロー制御
*   **最適化:**
    *   **フロー制御 (maxInflight):** フロントエンドは、バックエンドに同時に送信するリクエスト数を制限します（デフォルト: 8）。これがネットワーク混雑を防ぐための主要なスロットル（蛇口）として機能します。
    *   **ジッターバッファ:** フロントエンドは受信したフレームをソート済みのバッファに格納します。
    *   **リードタイム:** クライアントは現在の動画再生時間より `depthLeadMs`（デフォルト: 2000ms）**先** のフレームを要求します。このバッファがネットワークの揺らぎや推論の遅延スパイクを吸収します。
    *   **テクスチャ再利用:** `Three.js` の `DataTexture` は一度だけ確保し、以降は中身のバッファのみを更新（`gl.texSubImage2D`）します。これによりガベージコレクション（GC）による停止を防ぎます。
    *   **Frontend FPS:** バックエンドの応答数ではなく、実際にテクスチャが更新された回数を計測し、真の「見た目の滑らかさ」を指標化しています。

### 2. チューニングとフィードバックループ

システムはハードウェア性能に応じて調整可能です。

*   **テレメトリ:** バックエンドはメトリクス（`decode_s`, `infer_s`, `queue_wait_s`, `ws_send_s`）を収集し、フロントエンドに報告します。
*   **自動解像度制御 (バックエンド):**
    *   バックエンドは `infer_avg_s`（推論時間）、`queue_avg_s`（待ち時間）、`latency_ms`（RTT）を常時監視しています。
    *   **ダウングレード:** 推論が200ms超、キュー待ちが300ms超、またはRTTが500msを超えた場合、処理解像度を自動的に下げて（例: 640 → 512）FPSの回復を図ります。
    *   **アップグレード:** 全ての指標が健全（推論80ms以下など）な状態が続くと、徐々に解像度を元に戻します。
*   **手動チューニング (ユーザー):**
    *   **遅延が大きい?** -> `VIDEO_DEPTH_DOWNSAMPLE` を上げる、または `maxInflight` を下げる。
    *   **FPSが低い?** -> `VIDEO_DEPTH_INFER_WORKERS` を上げる、または `maxInflight` を上げる。
    *   **カクつく?** -> `QueueWait` を確認。高い場合はバックエンドが過負荷です（解像度を下げる）。
