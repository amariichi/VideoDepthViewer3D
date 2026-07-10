# VideoDepthViewer3D Optimization Details

[English](#english) | [日本語](#japanese)

---

<a name="english"></a>
## English

This document details the optimization mechanisms implemented in VideoDepthViewer3D to target smooth depth playback (30 FPS where the source and hardware permit) with low latency. The pipeline adapts compute and transport cost while keeping the depth stream synchronized with native-quality browser video.

### 1. Pipeline Architecture

The pipeline is divided into distinct stages, each optimized for throughput and latency. Stages A through E run on the **Backend**, while Stage F runs on the **Frontend**.

#### Source ingest and cache (before streaming)
*   **Current localhost behavior:** The browser plays the selected `File` directly, while the same compressed bytes are sent to the local FastAPI backend in 1 MiB chunks and written to `tmp/sessions/<session-id>/source.mp4`. This is a local process hand-off, not a cloud upload, when the app is opened at localhost; the application does not hold the whole video in RAM.
*   **Why a file is used:** Browser sandboxing does not expose a trustworthy filesystem path to Python. PyAV also benefits from a stable, seekable source shared by the decoder pool. The operating-system page cache keeps hot ranges in memory without requiring an application-sized RAM copy.
*   **Lifetime:** With the default data root, creating a new session clears prior session directories first, so the newest source copy remains until it is replaced or explicitly deleted. Cleanup is intentionally skipped for a custom data root unless `VIDEO_DEPTH_CLEAR_CACHE=1` is set.
*   **Known localhost cost:** The current path still duplicates the compressed source on disk before backend decoding. A trusted direct-path/native-picker mode is not implemented yet; upload remains the portable browser/remote fallback.

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
    *   **Concurrency:** `VIDEO_DEPTH_INFER_WORKERS` (default: 3). Multiple inference tasks may overlap on the GPU. Increase this only when measurements show spare GPU/VRAM capacity; excessive workers can reduce throughput or cause OOM.
    *   **Resolution:** `VIDEO_DEPTH_PROCESS_RES` (default: 640). Input images are resized before inference. Lowering this (for example, to 384) usually reduces GPU work at the cost of spatial depth detail.
    *   **Scale invariance:** Standalone DA3Metric output is multiplied by the processed focal length divided by its 300 px reference focal. Container rotation and SAR are normalized first. As a result, automatic `process_res` changes reduce detail without changing metric scene scale.
    *   **Backpressure:** A semaphore limits the number of concurrent CUDA tasks to prevent OOM (Out of Memory) errors.
    *   **Cold-start isolation:** Model construction is single-flight, so concurrent first requests cannot load the 1.3 GB checkpoint several times. Model loading and first-kernel warmup samples are excluded from steady-state automatic-quality decisions.

#### D. Pack Stage (Backend Data Reduction)
*   **Mechanism:** Quantization & Downsampling
*   **Optimization:**
    *   **Quantization:** Versioned packets support linear `uint16` (0-65535) for maximum precision and logarithmic `uint8` for lower bandwidth.
    *   **Log8 transport:** Smooth/Balanced use logarithmic `uint8` depth. It preserves relative depth precision and halves the uncompressed body again versus linear `uint16`; the browser expands it through a 256-entry lookup table rather than per-pixel exponentiation.
    *   **Stable range:** Transport bounds expand immediately for new scene content and contract only after a delay, avoiding frame-to-frame percentile pumping.
    *   **Useful-detail cap:** Transport dimensions are derived from the inference raster, not only the RGB source. A 2K/4K video therefore never causes a 640 px inference result to be upsampled and transmitted at a larger size with no additional model detail.
    *   **Downsampling:** `VIDEO_DEPTH_DOWNSAMPLE` (default: 1; common values: 2 or 4) reduces both transported dimensions relative to useful inference detail.
        *   Factor 2: 1/4 data size.
        *   Factor 4: 1/16 data size.
    *   **Benefit:** Reduces `pack_s`, payload bytes, and `ws_send_s`. This directly addresses the earlier frontend/backend transfer bottleneck while preserving the original RGB video resolution.

#### E. Send Stage (Backend Completion Order)
*   **Mechanism:** WebSocket Binary Stream
*   **Logic:** Each decode/infer/pack task is placed on `send_queue` as soon as it completes. If worker #3 finishes before worker #1, #3 is sent first; the backend never holds a ready frame behind a slow earlier request. EOF and decode misses receive an explicit JSON response so the browser can release the exact flow-control slot immediately.
*   **Benefit:** Removes request-order head-of-line stalls. Media timestamps, rather than network arrival order, define playback order; the frontend inserts every valid response into a timestamp-sorted buffer.

#### F. Rendering Stage (Frontend Sync)
*   **Mechanism:** `DepthBuffer` & Flow Control
*   **Optimization:**
    *   **Flow Control (maxInflight):** The frontend limits the number of concurrent requests sent to the backend (default: 8). This acts as the primary throttle to prevent network congestion.
    *   **Completion-order delivery:** Ready depth pipelines are sent immediately instead of waiting for earlier slow requests. The frontend accepts out-of-order responses and stores them in a timestamp-sorted buffer.
    *   **Lead Time:** Auto Lead requests at least measured RTT + 100 ms ahead (clamped to 100–3000 ms); manual mode uses `depthLeadMs`. This buffer absorbs network jitter and inference latency spikes.
    *   **Texture Reuse:** The `Three.js` `DataTexture` is allocated once and reused. We only update the underlying buffer (`gl.texSubImage2D`), avoiding Garbage Collection pauses.
    *   **Calibrated projection:** Pinhole mode uses normalized `fx`, `fy`, `cx`, and `cy` shared by Three.js and RawXR. Depth transport resolution may change without changing the reconstructed rays.
    *   **Continuous depth mesh:** Three.js and RawXR keep every grid triangle connected and displace its vertices from the depth texture. This deliberately favors locally textured transition surfaces over high-contrast holes at silhouettes, and avoids per-frame CPU topology classification or index-buffer uploads.
    *   **Source-aligned framing:** Auto Source View places the monitor eye at the reconstructed source-camera origin and fits all calibrated ray bounds into the active viewport. SBS fits each half separately with off-axis frusta. Manual orbit/placement switches to Free Orbit; Source View owns and disables its placement sliders.
    *   **XR anchor:** RawXR aligns the source-camera origin to the midpoint of the initial XR views once, then keeps that anchor fixed so later view motion creates parallax instead of head-locking the mesh.
    *   **Looking Glass reuse:** `Enter Looking Glass` lazily loads the official polyfill and then starts the same RawXR mesh path rather than maintaining a second renderer. Monitor startup avoids loading the separate polyfill chunk, and session end/failure restores monitor updates. Because the polyfill replaces the page-wide WebXR runtime, generic VR is disabled after activation until reload.
    *   **Applied depth FPS:** FPS counts unique depth timestamps actually applied to the texture, not render-loop iterations or raw backend replies. This is the throughput signal returned to the automatic controller.

### 2. Tuning & Feedback Loop

The system is designed to be tunable based on hardware capabilities.

*   **Telemetry:** The backend separates `decode_s`, inference-slot `infer_wait_s`, model execution `infer_s`, `pack_s`, `queue_wait_s`, `ws_send_s`, and payload bytes. The browser reports end-to-end RTT and unique applied depth FPS.
*   **Automatic modes:** Smooth and Balanced target 30 applied depth FPS; Quality targets 24 FPS; all targets are capped by source FPS and Manual disables adaptation. The deterministic state machine feeds back unique browser-applied depth FPS, separates inference execution from slot wait, and treats only RTT remaining after measured server work as transport latency. Startup samples, bad/good streaks, and cooldown prevent cold-load or transient oscillation.
    *   **Network downgrade:** Switch linear16 to log8 first, then increase depth downsampling, then lower inference resolution.
    *   **Compute downgrade:** Lower inference resolution first. Metric focal correction prevents a scale jump.
    *   **Upgrade:** Restore resolution, spatial transport quality, and preferred precision only after sustained headroom.
*   **Manual tuning:** Start with Auto Balanced and use its reported limiting stage before changing one lever at a time.
    *   **Inference/throughput limited:** Lower process resolution first. Increase inference workers only when GPU utilization and VRAM measurements show headroom.
    *   **Transport limited:** Prefer log8, then increase depth downsampling; lower `maxInflight` if requests are accumulating rather than completing.
    *   **Decode limited:** Increase decoder workers cautiously on a many-core CPU; each PyAV decoder also uses FFmpeg frame/slice threads.
    *   **High `QueueWait`:** Reduce inference resolution or inflight work. Adding more requests to an overloaded queue makes latency worse.

---

<a name="japanese"></a>
## 日本語

本ドキュメントでは、VideoDepthViewer3Dでsourceとhardwareが許す範囲の滑らかなdepth再生（目標30 FPS）と低遅延を実現する仕組みを解説します。native品質のbrowser動画との同期を保ちながら、計算量と転送量を自動調整します。

### 1. パイプラインアーキテクチャ

パイプラインは複数のステージに分かれており、各ステージでスループットと遅延の最適化が行われています。ステージA〜Eは**バックエンド**、ステージFは**フロントエンド**で動作します。

#### Source取り込みとcache（streaming前）
*   **現在のlocalhost動作:** browserは選択した`File`を直接再生し、同じ圧縮bytesを1 MiBずつlocal FastAPI backendへ渡して`tmp/sessions/<session-id>/source.mp4`へ保存します。localhostで開いている場合、これはcloud uploadではなくprocess間の受け渡しです。動画全体をapplication RAMへ保持しません。
*   **fileを使う理由:** browser sandboxはPythonが利用できる信頼可能なfilesystem pathを公開しません。また、PyAV decoder poolには安定したseek可能sourceが適しています。頻繁に読む範囲はOS page cacheに載るため、動画全体のRAM copyをapplication側で持つ必要はありません。
*   **保持期間:** default data rootでは新session作成前に従来session directoryを消すため、最新のsource copyだけが次の置換または明示削除まで残ります。custom data rootは安全のため`VIDEO_DEPTH_CLEAR_CACHE=1`なしでは自動削除しません。
*   **localhostでの既知cost:** 現状はbackend decode前に圧縮source全体をdiskへ複製します。信頼済みdirect-path/native picker modeはまだ未実装で、uploadはbrowser/remote互換経路として残っています。

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
    *   **並列実行:** `VIDEO_DEPTH_INFER_WORKERS`（デフォルト: 3）で複数推論をoverlapできます。GPU/VRAMに余裕があると計測できた場合だけ増やしてください。過剰なworkerはthroughput低下やOOMを招きます。
    *   **解像度制御:** `VIDEO_DEPTH_PROCESS_RES`（デフォルト: 640）。推論前に入力画像をresizeします。値を下げる（例: 384）と通常はGPU処理を減らせますが、空間depth detailは低下します。
    *   **尺度不変性:** 単体DA3Metricの出力に「実処理後の焦点距離 / 基準300px」を乗算します。先にコンテナ回転とSARを正規化するため、自動`process_res`変更はディテールだけを下げ、metricシーン尺度を変えません。
    *   **バックプレッシャー:** セマフォを用いて同時実行されるCUDAタスク数を制限し、VRAM不足（OOM）を防ぎます。
    *   **cold-start分離:** model構築はsingle-flightで、最初の同時requestが1.3 GB checkpointを重複loadしません。model loadと初回kernel warmup sampleはsteady-stateの自動品質判定から除外します。

#### D. パックステージ (バックエンド データ削減)
*   **使用技術:** 量子化 & ダウンサンプリング
*   **最適化:**
    *   **量子化:** version付きpacketは最大精度のlinear `uint16`（0-65535）と、低帯域の対数`uint8`を扱います。
    *   **Log8転送:** Smooth/Balancedは対数`uint8` depthを使います。相対精度を保ちながら非圧縮linear `uint16`の転送量をさらに半減し、ブラウザはpixelごとの指数計算ではなく256要素LUTで復元します。
    *   **安定レンジ:** 新しいscene範囲には即時拡張し、縮小は待機後にゆっくり行うため、frameごとのpercentile変動を抑えます。
    *   **有効detail上限:** 転送寸法はRGB sourceだけでなく推論rasterから決めます。そのため2K/4K動画でも、640px推論結果をdetailが増えない大きな寸法へ再拡大して送信しません。
    *   **ダウンサンプリング:** `VIDEO_DEPTH_DOWNSAMPLE`（デフォルト: 1、一般的な値: 2または4）は有効な推論detailを基準に縦横を縮小します。
        *   係数 2: データサイズ 1/4
        *   係数 4: データサイズ 1/16
    *   **効果:** `pack_s`、payload bytes、`ws_send_s`を削減します。元のRGB動画解像度を維持したまま、以前のfrontend/backend転送bottleneckを直接軽減します。

#### E. 送信ステージ (バックエンド 完成順)
*   **使用技術:** WebSocket バイナリストリーム
*   **仕組み:** decode/infer/pack taskは完了した時点で`send_queue`へ入ります。worker #3が#1より先に終われば#3を先に送り、ready frameを遅い先行requestの後ろへ保持しません。EOF/decode missにも明示的なJSON responseを返し、browserは該当flow-control slotを即時解放できます。
*   **効果:** request順によるhead-of-line停止を除去します。再生順はnetwork到着順ではなくmedia timestampで決まり、frontendが全valid responseをtimestamp順bufferへ挿入します。

#### F. レンダリングステージ (フロントエンド 同期)
*   **使用技術:** `DepthBuffer` & フロー制御
*   **最適化:**
    *   **フロー制御 (maxInflight):** フロントエンドは、バックエンドに同時に送信するリクエスト数を制限します（デフォルト: 8）。これがネットワーク混雑を防ぐための主要なスロットル（蛇口）として機能します。
    *   **完成順送信:** 先行する遅いrequestを待たず、完成したdepthから即送信します。フロントエンドは順不同responseを受理し、timestamp順bufferへ格納します。
    *   **リードタイム:** Auto Leadは計測RTT + 100ms以上（100〜3000msにclamp）を先読みし、manual時は`depthLeadMs`を使います。このbufferがnetwork揺らぎや推論遅延spikeを吸収します。
    *   **テクスチャ再利用:** `Three.js` の `DataTexture` は一度だけ確保し、以降は中身のバッファのみを更新（`gl.texSubImage2D`）します。これによりガベージコレクション（GC）による停止を防ぎます。
    *   **校正済み投影:** pinholeモードはThree.jsとRawXRで共通の正規化`fx`、`fy`、`cx`、`cy`を使います。デプス転送解像度が変わっても再構成rayは変化しません。
    *   **連続depth mesh:** Three.jsとRawXRは全grid triangleを接続したまま、depth textureで頂点を変位させます。silhouetteに高contrastな穴を開けず、近傍動画色の遷移面を優先する意図的な判断で、毎frameのCPU topology判定とindex-buffer更新も不要です。
    *   **source整合framing:** Auto Source Viewはmonitor eyeを再構成source-camera原点へ置き、校正ray境界全体がactive viewportへ入るようfitします。SBSは各halfをoff-axis frustumで個別fitします。manual orbit/配置でFree Orbitへ移り、Source View中は配置sliderを無効化します。
    *   **XR anchor:** RawXRはsession開始時にsource-camera原点を初期XR viewの中点へ一度だけ合わせ、その後固定します。後続view移動はmeshのhead-lockではなくparallaxになります。
    *   **Looking Glass再利用:** `Enter Looking Glass`は公式polyfillを遅延loadしてから、別rendererではなく同じRawXR mesh pathを開始します。通常monitor起動は分離されたpolyfill chunkを読み込まず、session終了/失敗時はmonitor updateへ復帰します。polyfillはpage全体のWebXR runtimeを置き換えるため、起動後のgeneric VRはreloadまで無効化します。
    *   **適用depth FPS:** render-loop回数やbackend reply数ではなく、textureへ実際に適用した固有depth timestampを数えます。この値を自動controllerへfeedbackします。

### 2. チューニングとフィードバックループ

システムはハードウェア性能に応じて調整可能です。

*   **テレメトリ:** backendは`decode_s`、推論slotの`infer_wait_s`、model実行`infer_s`、`pack_s`、`queue_wait_s`、`ws_send_s`、payload bytesを分離します。browserはend-to-end RTTと実適用depth FPSを返します。
*   **自動モード:** Smooth/Balancedは適用depth 30 FPS、Qualityは24 FPSを目標とし、source FPSを上限にします。Manualは適応を停止します。決定論的state machineはbrowserで実適用された固有depth FPSをfeedbackし、推論実行とslot待ちを分離し、server実測時間を引いたRTT残差だけを転送遅延として扱います。startup sample、bad/good streak、cooldownでcold loadや一時的な振動を防ぎます。
    *   **ネットワーク劣化時:** linear16→log8、depth downsample増加、推論解像度低下の順。
    *   **計算律速時:** 推論解像度を先に下げます。metric焦点補正により尺度jumpは起きません。
    *   **回復時:** 十分なheadroomが継続してから解像度、空間転送品質、精度を戻します。
*   **手動チューニング:** まずAuto Balancedを使い、表示された律速stageを確認してから一度に1つだけ変更します。
    *   **推論/throughput律速:** process resolutionを先に下げます。inference worker追加はGPU使用率とVRAMに余裕がある場合だけ行います。
    *   **転送律速:** log8を優先し、その後depth downsampleを増やします。requestが完了せず蓄積する場合は`maxInflight`を下げます。
    *   **decode律速:** many-core CPUでdecoder workerを慎重に増やします。各PyAV decoderもFFmpeg frame/slice threadを使います。
    *   **`QueueWait`が高い:** 推論解像度またはinflight workを下げます。過負荷queueへrequestを追加すると遅延は悪化します。
