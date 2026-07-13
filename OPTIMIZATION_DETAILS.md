# VideoDepthViewer3D Optimization Details

[English](#english) | [日本語](#japanese)

---

<a name="english"></a>
## English

This document is the implementation-level reference for depth-pipeline
throughput and latency. The primary goal is smooth, synchronized depth playback
at 30 FPS when the source FPS and hardware permit it. RGB video uses the source
directly whenever the browser supports its codec; automatic modes spend depth
resolution, transport precision, and mesh density instead. If a browser rejects
an otherwise decodable HEVC/MOV source, a one-time H.264 display copy is made
outside the live depth timing path.

Display geometry and depth-safety rules are documented separately at the end
because they protect 3D correctness but are not inference-speed controls.

### 1. Throughput Pipeline

| Stage | Main mechanism | Main cost or signal |
| :--- | :--- | :--- |
| Request admission | Frontend inflight limit plus backend dropping queue | `queue_wait_s`, dropped requests |
| Decode | Four seekable PyAV decoders with forward-stream reuse | `decode_s` |
| Display normalization | Rotation/SAR normalization with OpenCV | `normalize_s` |
| Inference | Bounded concurrent DA3Metric work at adaptive resolution | `infer_wait_s`, `infer_s` |
| Pack | Stable-range quantization, log8, and spatial downsampling | `pack_s`, payload bytes |
| Send | Completion-order WebSocket delivery | `ws_send_s`, end-to-end RTT |
| Browser apply | Timestamp-sorted buffer, bounded mesh, texture upload | applied depth FPS, sync delta |

#### A. Request admission and stale-work prevention

- The frontend admits requests only while `maxInflightRequests` has free slots.
- The backend `DroppingQueue` holds at most 32 waiting requests. If it fills,
  the oldest waiting request is discarded so work stays close to the current
  playback position.
- The backend also bounds active pipeline tasks to
  `max(inference_workers * 2, decoder_workers)`. This keeps decode work available
  without allowing an unbounded number of tasks to wait for inference.
- EOF and decode misses receive an explicit timestamped JSON response. The
  browser releases that exact inflight slot immediately instead of waiting for
  its stale-request timeout.

The dropping queue is a last safety net. Normal flow control happens in the
browser before requests reach it.

#### B. Decode parallelism and result cache

- `DecoderPool` owns four `FrameDecoder` instances by default.
- A free decoder already positioned 0–1000 ms before the requested timestamp is
  reused and streamed forward, avoiding a keyframe seek.
- If no free decoder can stream forward, the pool reuses the most recently
  returned decoder (LIFO, keeping a hot decoder active) and seeks to the
  preceding keyframe. This reduces, but does not eliminate, seek and serial
  decode cost.
- Each PyAV decoder enables FFmpeg frame/slice threading. Decoder count must be
  increased cautiously because these internal threads can oversubscribe a CPU.
- A timestamp-sorted depth-result cache retains eight recent completed frames by
  default. A request within 33 ms of a cached frame skips decode and inference
  and only repacks the result for the current transport encoding.

#### C. Display normalization and high-resolution pre-resize

- Rotation metadata and sample-aspect ratio are normalized into square-pixel
  display coordinates before inference so browser RGB and depth share one UV
  mapping.
- This stage is timed separately as `normalize_s`.
- Before a 2K/4K frame is converted to a PIL image or passed into DA3, OpenCV
  limits its longest side to `process_res`. This avoids constructing and then
  downscaling a full-resolution model input that cannot add depth detail.
- The on-demand H.264 browser fallback bakes this same rotation/SAR transform
  and preserves source frame timestamps. Depth decoding continues to use the
  original file, so RGB and depth retain one display coordinate system. The
  fallback tries bundled hardware H.264 encoding first and uses libx264 when it
  is unavailable; its one-time preparation cost is not counted as depth FPS.

#### D. DA3Metric inference

- `VIDEO_DEPTH_INFER_WORKERS` defaults to 3. An asyncio semaphore bounds all
  inference-device work, while execution occurs in worker threads so the event
  loop remains responsive.
- More workers are not automatically selected. They can improve throughput only
  when the GPU/device and VRAM have measured headroom; excessive concurrency can
  reduce throughput or cause OOM.
- `VIDEO_DEPTH_PROCESS_RES` defaults to 640 and is the global inference
  resolution ceiling. Lower resolution reduces model work at the cost of depth
  detail.
- Standalone DA3Metric output is multiplied by the processed focal length
  divided by its 300 px reference focal. Because rotation/SAR normalization and
  actual processed dimensions are included, automatic resolution changes do not
  change metric scene scale.
- Model construction is protected by a process-wide lock. Concurrent first
  requests cannot download/load the checkpoint repeatedly.
- `infer_wait_s` and `infer_s` are recorded separately. Cold model-load samples
  do not update steady-state inference averages, and the automatic controller
  also has a warmup window.

#### E. Depth packing and transfer-size reduction

- Transport size is calculated from useful inference detail:
  `min(source_longest_side, process_res) / downsample`. A 2K/4K RGB source
  therefore does not cause a 640 px inference result to be upscaled and sent at
  a larger size.
- Downsample 2 reduces sample count to approximately one quarter; downsample 4
  reduces it to approximately one sixteenth.
- `linear16` stores one unsigned 16-bit sample per depth value.
- `log8` stores logarithmic unsigned 8-bit values. It halves the uncompressed
  body relative to linear16 while preserving relative rather than absolute
  precision. The browser builds a 256-entry exponential lookup table once per
  packet and then performs table lookups per sample.
- Quantization bounds expand immediately when a scene exceeds the retained
  range, but contract only after sustained evidence. This avoids visible scale
  pumping caused by per-frame percentile noise.
- `VIDEO_DEPTH_COMPRESSION=0` disables zlib and is the low-latency localhost
  default. Values 1–9 now select the corresponding zlib level. Compression can
  reduce payload bytes on a slow network but adds backend and browser CPU work.
- `pack_s` and payload size are measured independently from `ws_send_s`.

#### F. Completion-order delivery

Decode/infer/pack tasks enter the send queue when they complete, not in request
order. A later request that is already ready is never held behind a slow earlier
seek or inference. The browser accepts every valid response, inserts it into a
timestamp-sorted buffer, and uses media timestamps—not arrival order—for
playback.

This removes request-order head-of-line blocking while keeping WebSocket writes
serialized.

#### G. Browser scheduling and rendering cost

- The initial inflight value is 8. In automatic modes, the status controller
  replaces it with inference workers × 2/3/4 for Smooth/Balanced/Quality. With
  the default three inference workers, these become 6, 9, and 12. Manual mode
  leaves the user setting unchanged.
- Playback Auto Lead requests from RTT + 100 ms ahead, clamped to 100–3000 ms.
  Manual mode uses `depthLeadMs`. The disabled manual value is kept near the
  measured queue+decode+normalize+inference-wait+inference+pack cost so switching
  Auto Lead off starts from a useful value.
- The look-ahead window is three seconds, but only currently available inflight
  slots are marked as requested. Missing or timed-out timestamps may be
  requested again.
- Out-of-order packets are stored by timestamp. A depth frame is applied only
  when it falls within the 33 ms playback tolerance.
- Each packet expands into a new CPU `Float32Array`. When depth dimensions stay
  unchanged, Three.js reuses the GPU `DataTexture` object and uploads the new
  data. An automatic resolution/downsample transition changes dimensions and
  therefore recreates the texture. The implementation reduces GPU-object churn;
  it does not eliminate all per-frame CPU allocation or garbage collection.
- Automatic modes cap mesh density at 60k/140k/240k target triangles for
  Smooth/Balanced/Quality. The actual count is also capped by the transported
  depth grid, so stronger downsampling automatically lowers render work.
- The grid topology remains connected and static. Vertex depth comes from the
  texture in the shader, avoiding per-frame CPU discontinuity classification
  and index-buffer upload.
- Applied depth FPS counts unique timestamps actually uploaded for display. It
  does not count request replies or render-loop iterations.

### 2. Automatic Quality Controller

`VIDEO_DEPTH_PROCESS_RES` is a global ceiling for every mode. With its default
value of 640, Auto Quality begins at 640 even though its preferred resolution is
960.

| Mode | FPS target | Latency budget | Preferred / minimum process res | Initial / maximum downsample | Preferred encoding | Mesh cap | Inflight multiplier |
| :--- | ---: | ---: | :--- | :--- | :--- | ---: | ---: |
| Smooth | 30 | 180 ms | 480 / 320 | 2 / 4 | log8 | 60k | 2× |
| Balanced | 30 | 250 ms | 640 / 384 | 2 / 4 | log8 | 140k | 3× |
| Quality | 24 | 400 ms | 960 / 480 | 1 / 2 | linear16 | 240k | 4× |
| Manual / Creative | none | none | configured | configured | configured | user value | user value |

All automatic FPS targets are capped by source FPS.

#### Controller inputs

The backend maintains exponential moving averages for:

- queue wait;
- decode;
- display normalization;
- inference-slot wait;
- model execution;
- pack;
- WebSocket send;
- end-to-end browser RTT;
- browser-applied unique depth FPS.

Payload bytes and delivery FPS are displayed for diagnosis but are not direct
state-machine inputs.

For transport classification, the controller calculates:

`transport latency = max(browser RTT - all measured server stages, 0)`

The measured server stages now include queue, decode, normalization,
inference-slot wait, inference, pack, and WebSocket send. Expensive quantization
or display normalization therefore cannot by itself spend network-quality
levers. The residual is transport-path cost rather than wire-only network time:
it also includes browser message delivery and packet expansion, which are not
timed as separate stages.

#### Decisions and hysteresis

- Estimated model capacity is
  `workers / (infer_s + 0.25 * decode_s)`.
- Capacity or applied FPS below 90% of the target is bad compute/throughput
  evidence.
- Queue wait above 50% of the mode latency budget is queue pressure.
- Residual transport latency above the full latency budget, or WebSocket send
  above 35% of one target-frame interval, is network pressure.
- Three consecutive bad observations are required before downgrade.
- Thirty good observations are required before upgrade.
- A successful change starts a 60-observation cooldown.
- The first 120 observations are a warmup window, preventing model load and
  initial pipeline fill from immediately reducing quality.

#### Adjustment order

- Network pressure: linear16 → log8, then increase depth downsampling, then
  lower inference resolution.
- Compute, queue, or low applied FPS: lower inference resolution only.
  Post-inference downsampling cannot reduce model execution time.
- Sustained headroom: restore inference resolution first, then spatial transport
  resolution, then the preferred encoding.
- Inference worker count is never changed automatically.

### 3. Measuring Performance

#### Live telemetry

The UI exposes the current queue, decode, normalize, inference wait, infer,
pack, send, inflight, process resolution, downsample, payload size, limiter,
applied depth FPS, and sync delta. Set `VIDEO_DEPTH_PROFILE_TIMING=1` for
per-frame backend timing logs. Five-second backend summaries include average,
p95, and maximum stage times.

Interpret the values by comparing both time and throughput:

- `infer_s` is per-task execution, while applied depth FPS measures overlapped
  end-to-end throughput.
- `infer_wait_s` or `queue_wait_s` growing means the pipeline is over-admitted,
  even if individual inference calls are fast.
- `ws_send_s` and residual RTT indicate transport pressure.
- `pack_s` and payload bytes show whether quantization/downsampling is helping
  or merely moving cost onto the CPU.

#### Sequential hardware benchmark

Run:

```bash
uv run --locked --extra dev --extra inference python scripts/benchmark_pipeline.py \
  --process-res 640 --downsample 2 --encoding log8 \
  --output tmp/benchmark-balanced.json
```

The report records decode, normalization, inference, pack, payload size,
hardware/software versions, and p50/p95/max distributions. Its
`sequential_fps` is deliberately single-decoder, single-inference throughput. It
does not include concurrent workers, WebSocket transfer, browser packet
expansion, texture upload, mesh rendering, or adaptive control. It is useful for
comparing one GPU/codec/setting at a time, but browser-applied depth FPS is the
authoritative end-to-end result.

### 4. Tuning Guide

- Start with Auto Balanced and allow the warmup window to finish.
- Inference/throughput limiter: lower process resolution. Increase inference
  workers only after checking GPU utilization and VRAM.
- High inference wait or queue wait: reduce resolution or inflight work. Adding
  more requests to an overloaded queue increases latency.
- High decode time: increase decoder workers cautiously on a many-core CPU.
  Seeking and codec complexity can dominate even when storage bandwidth is
  sufficient.
- High normalization time on 2K/4K or anamorphic sources: reduce process
  resolution; the early pre-resize and square-pixel normalization then process
  fewer pixels.
- High pack time or payload: use log8, increase downsampling, and keep zlib off
  on localhost unless measurements show a net benefit.
- High send/residual RTT: reduce transport precision and spatial depth size
  before reducing RGB video quality.
- Low browser/render FPS with healthy backend throughput: use Smooth or
  Balanced so the mesh and depth grid caps fall together.

Change one lever at a time and compare warm p50/p95 results, not a single cold
frame.

### 5. Display Geometry and Depth Safety

The following mechanisms preserve 3D correctness and visual stability. They are
not DA3 inference-speed controls, although some are implemented with bounded
work to avoid hurting FPS.

- Pinhole reconstruction uses shared normalized `fx`, `fy`, `cx`, and `cy` in
  Three.js and RawXR. Transport resolution may change without changing source
  rays.
- Auto Source View fits calibrated source boundaries and keeps placement
  sliders under one owner. SBS uses fixed-IPD off-axis frusta without translating
  the mesh over time.
- The connected mesh intentionally renders locally textured transition surfaces
  instead of cutting black cracks at depth discontinuities.
- Looking Glass reuses RawXR and loads its runtime only after explicit entry.
  Wheel zoom and pan modify projection only, avoiding vendor configuration
  updates and quilt reallocation during interaction.
- Looking Glass Source View spends a fixed 2,048-sample budget inside the source
  region currently visible after Hologram Zoom and pan, including a small
  projection guard band. Its q1/q10/q20 statistics drive normal convergence,
  reachable-depth rebasing, and foreground recovery; too few valid samples hold
  the previous target instead of guessing. A cropped view may require a second
  sparse traversal because full-frame q1 is retained independently for the
  vendor near-plane guard. Click-selected focus remains locked across ordinary
  motion until Resume Auto, while scene changes or unsafe foreground can release
  it. When a scene lies outside the supported convergence range, an
  apex-centered uniform depth transform preserves source rays and straight
  borders.

These rules are mode-gated; monitor, SBS, generic WebXR, Looking Glass Source
View, and creative/free-orbit paths do not silently share incompatible placement
logic.

### 6. Known Performance Limits

- Inference workers are configured, not auto-discovered or changed at runtime.
- PyAV currently uses software decode; hardware video decode is not integrated.
- Log8 expansion and `Float32Array` creation occur on the browser main thread.
- Depth texture objects are recreated when an automatic quality change alters
  transport dimensions.
- The included benchmark is sequential and must not be reported as end-to-end
  interactive FPS.

---

<a name="japanese"></a>
## 日本語

この文書は、深度パイプラインのスループットと遅延について、現在の実装を正確に
説明するための技術資料です。元動画のFPSとハードウェアが許す場合に、動画と同期した
深度表示30 FPSを目標にします。ブラウザがコーデックに対応している場合はRGB元動画を
直接再生し、自動モードは深度解像度、転送精度、メッシュ密度を調整します。ブラウザが
backendでdecode可能なHEVC/MOVを拒否した場合だけ、live depth計測外で一度だけH.264
表示用コピーを作成します。

表示幾何と奥行き安全処理は3Dの正確性を守る機能であり、推論速度制御ではないため、
末尾の別節に分けています。

### 1. スループットパイプライン

| 段階 | 主な仕組み | 主なコスト・計測値 |
| :--- | :--- | :--- |
| リクエスト受け入れ | フロントエンドのinflight制限とbackend dropping queue | `queue_wait_s`、破棄数 |
| デコード | 前方再生を再利用する4個のPyAV decoder | `decode_s` |
| 表示正規化 | OpenCVによる回転/SAR正規化 | `normalize_s` |
| 推論 | 解像度を調整し、同時数を制限したDA3Metric | `infer_wait_s`、`infer_s` |
| パック | 安定range量子化、log8、空間downsample | `pack_s`、payload bytes |
| 送信 | 完成順WebSocket送信 | `ws_send_s`、end-to-end RTT |
| ブラウザ適用 | timestamp順buffer、上限付きmesh、texture upload | 適用depth FPS、同期差 |

#### A. リクエスト受け入れと古い処理の防止

- フロントエンドは`maxInflightRequests`に空きがある場合だけ要求を送ります。
- backendの`DroppingQueue`は待機要求を最大32件保持します。満杯になると最も古い
  待機要求を捨て、現在の再生位置に近い処理を優先します。
- backendのactive pipeline taskも
  `max(inference_workers * 2, decoder_workers)`に制限します。decodeを並列に進めつつ、
  推論待ちtaskが無制限に増えることを防ぎます。
- EOFやdecode missにもtimestamp付きJSON応答を返します。browserはtimeoutを待たず、
  対応するinflight slotをすぐ解放できます。

Dropping queueは最終的な安全装置で、通常の流量制御はbrowser側で行います。

#### B. デコード並列化と結果cache

- `DecoderPool`はデフォルトで4個の`FrameDecoder`を持ちます。
- 要求時刻の0〜1000 ms手前にいる空きdecoderがあれば、seekせず前方decodeを続けます。
- 適切なdecoderがなければ、最後に返却されたdecoderをLIFOで再利用して直前keyframeへ
  seekします。hotなdecoderを維持する方式であり、最長未使用decoderではありません。
- 各PyAV decoderはFFmpegのframe/slice threadも使います。decoder数を増やしすぎると
  CPU threadが過剰になるため注意が必要です。
- timestamp順のdepth結果cacheは、デフォルトで直近8枚を保持します。要求時刻から
  33 ms以内の結果があればdecodeと推論を省略し、現在のencodingでpackだけを行います。

#### C. 表示正規化と高解像度事前縮小

- container回転とSARを推論前にsquare-pixel表示座標へ正規化し、browser RGBとdepthが
  同じUVを使えるようにします。
- この処理時間を`normalize_s`として独立計測します。
- 2K/4K frameをPIL image化またはDA3へ渡す前に、OpenCVで最長辺を`process_res`まで
  縮小します。深度detailを増やさないfull-resolution model inputの生成と再縮小を
  避けます。
- H.264 browser fallbackは同じ回転/SAR変換を焼き込み、元frame timestampを維持します。
  depth decodeは元ファイルを使い続けるため、RGBとdepthは同じ表示座標系を保ちます。
  同梱hardware H.264 encoderを先に試し、使えない場合はlibx264へfallbackします。この
  一度だけの準備時間はdepth FPSへ含めません。

#### D. DA3Metric推論

- `VIDEO_DEPTH_INFER_WORKERS`のデフォルトは3です。asyncio semaphoreで推論device上の
  同時処理数を制限し、worker threadで実行してevent loopの停止を避けます。
- worker数は自動変更しません。GPU/deviceとVRAMに余裕があると計測できた場合だけ、
  増加がthroughput改善につながります。過剰な並列化は低速化やOOMを招きます。
- `VIDEO_DEPTH_PROCESS_RES`のデフォルト640は、全モード共通の推論解像度上限です。
  下げると推論量が減りますが、depth detailも低下します。
- 単体DA3Metric出力へ「処理後焦点距離 / 基準300 px」を乗算します。回転/SARと実処理
  寸法を含めるため、自動解像度変更でmetric scene scaleは変わりません。
- model構築はprocess-wide lockで保護され、最初の同時requestがcheckpointを重複load
  しません。
- 推論slot待ち`infer_wait_s`と実model処理`infer_s`を分離します。cold model loadは
  steady-state推論平均へ入れず、自動controllerにもwarmup期間があります。

#### E. 深度パックと転送量削減

- 転送寸法は有効な推論detailから
  `min(source長辺, process_res) / downsample`として決めます。2K/4K RGBでも640 px
  推論結果を大きく再拡大して送りません。
- downsample 2でsample数は約1/4、4で約1/16になります。
- `linear16`は1 depth値を符号なし16 bitで表現します。
- `log8`は対数の符号なし8 bitです。絶対精度より相対精度を保ち、非圧縮bodyを
  linear16の半分にします。browserはpacketごとに256要素の指数LUTを作り、各sampleは
  table lookupで復元します。
- 量子化rangeは新しいscene範囲へ即時拡張し、十分な継続確認後にだけ縮小します。
  frameごとのpercentile揺れによるscale pumpingを避けます。
- `VIDEO_DEPTH_COMPRESSION=0`はzlib無効で、localhost低遅延向けデフォルトです。
  1〜9は実際のzlib levelとして使用します。遅いnetworkではpayloadを減らせますが、
  backendとbrowserのCPU処理が増えます。
- `pack_s`、payload size、`ws_send_s`は別々に計測します。

#### F. 完成順送信

decode/infer/pack taskはrequest順ではなく完成した時点でsend queueへ入ります。
後から要求したframeが完成済みなら、遅い先行seekや推論の後ろで待たせません。
browserは全valid responseを受け入れてtimestamp順bufferへ挿入し、network到着順ではなく
media timestampで再生します。

これによりrequest順head-of-line停止を除去しつつ、WebSocket write自体は直列化します。

#### G. ブラウザのscheduleと描画負荷

- 初期inflight値は8です。自動モードではstatus controllerが推論worker数×2/3/4を
  Smooth/Balanced/Qualityへ設定します。デフォルト3 workerなら6、9、12です。
  Manualはuser設定を維持します。
- 再生中のAuto LeadはRTT+100 ms先を要求し、100〜3000 msへ制限します。Manualは
  `depthLeadMs`を使います。無効表示中のmanual値には
  queue+decode+normalize+推論待ち+推論+packの実測値を反映するため、Autoを切った時も
  現実的な値から始められます。
- 先読みwindowは3秒ですが、実際に空いているinflight slot分だけrequestedとして
  記録します。未取得またはtimeoutしたtimestampは再要求できます。
- 順不同packetはtimestamp順に保持し、再生時刻から33 ms以内のdepthだけを適用します。
- 各packetは新しいCPU `Float32Array`へ展開されます。depth寸法が同じ間はThree.jsの
  GPU `DataTexture` objectを再利用してdataだけuploadします。自動解像度/downsample
  遷移で寸法が変わる場合はtextureを再生成します。GPU object churnは減らしますが、
  frameごとのCPU allocationやGCを完全には無くしません。
- 自動モードのmesh上限はSmooth/Balanced/Qualityで60k/140k/240k target trianglesです。
  実countは転送depth gridでも制限するため、downsample時は描画負荷も自動で下がります。
- grid topologyは接続・固定したまま、shaderがdepth textureから頂点を変位させます。
  frameごとのCPU不連続判定とindex-buffer uploadを避けます。
- 適用depth FPSは実際に表示uploadした固有timestampだけを数えます。backend reply数や
  render-loop回数ではありません。

### 2. 自動品質controller

`VIDEO_DEPTH_PROCESS_RES`は全modeの共通上限です。デフォルト640では、Auto Qualityの
希望値が960でも初期値は640になります。

| Mode | FPS目標 | 遅延budget | 希望 / 最小process res | 初期 / 最大downsample | 希望encoding | Mesh上限 | Inflight倍率 |
| :--- | ---: | ---: | :--- | :--- | :--- | ---: | ---: |
| Smooth | 30 | 180 ms | 480 / 320 | 2 / 4 | log8 | 60k | 2× |
| Balanced | 30 | 250 ms | 640 / 384 | 2 / 4 | log8 | 140k | 3× |
| Quality | 24 | 400 ms | 960 / 480 | 1 / 2 | linear16 | 240k | 4× |
| Manual / Creative | なし | なし | 設定値 | 設定値 | 設定値 | user値 | user値 |

自動FPS目標はすべて元動画FPSを上限にします。

#### Controller入力

backendは次の指数移動平均を保持します。

- queue待ち
- decode
- 表示正規化
- 推論slot待ち
- model実行
- pack
- WebSocket send
- browser end-to-end RTT
- browserで実適用した固有depth FPS

payload bytesとdelivery FPSは診断表示しますが、state machineの直接入力ではありません。

転送判定では次を計算します。

`transport latency = max(browser RTT - 計測済み全server stage, 0)`

server stageにはqueue、decode、normalize、推論slot待ち、推論、pack、WebSocket sendを
含めます。量子化や表示正規化が重いだけでnetwork品質を下げることはありません。
この残差は回線だけではなく転送経路全体のcostであり、個別計測していないbrowserの
message deliveryとpacket展開も含みます。

#### 判定とhysteresis

- model capacity推定は`workers / (infer_s + 0.25 * decode_s)`です。
- capacityまたは適用FPSが目標の90%未満ならcompute/throughput悪化と判定します。
- queue待ちがmode遅延budgetの50%を超えるとqueue pressureです。
- 残差transport latencyが遅延budget全体を超える、またはWebSocket sendが目標1 frame
  時間の35%を超えるとnetwork pressureです。
- downgradeには3回連続のbad observationが必要です。
- upgradeには30回連続のgood observationが必要です。
- 変更成功後は60 observationのcooldownを入れます。
- 最初の120 observationはwarmupで、model loadとpipeline初期充填による即時劣化を
  防ぎます。

#### 調整順

- Network pressure: linear16→log8、depth downsample増加、推論解像度低下の順。
- Compute、queue、適用FPS低下: 推論解像度だけを下げます。推論後downsampleでは
  model実行時間を減らせません。
- 継続headroom: 推論解像度、空間転送解像度、希望encodingの順に戻します。
- 推論worker数は自動変更しません。

### 3. 性能計測

#### Live Telemetry

UIはqueue、decode、normalize、推論待ち、infer、pack、send、inflight、
process resolution、downsample、payload、limiter、適用depth FPS、同期差を表示します。
`VIDEO_DEPTH_PROFILE_TIMING=1`でframe別backend timing logを有効にできます。
5秒ごとのbackend summaryには各stageの平均、p95、最大値が出ます。

時間とthroughputの両方を見て判断します。

- `infer_s`はtask単体時間、適用depth FPSは並列処理後のend-to-end throughputです。
- `infer_wait_s`や`queue_wait_s`が増える場合、個々の推論が速くても要求過多です。
- `ws_send_s`と残差RTTは転送pressureを示します。
- `pack_s`とpayload bytesにより、量子化/downsampleが有効か、CPUへ負荷を移しただけか
  を判断できます。

#### 逐次hardware benchmark

実行例:

```bash
uv run --locked --extra dev --extra inference python scripts/benchmark_pipeline.py \
  --process-res 640 --downsample 2 --encoding log8 \
  --output tmp/benchmark-balanced.json
```

reportはdecode、normalize、infer、pack、payload size、hardware/software version、
p50/p95/maxを記録します。`sequential_fps`は意図的にsingle decoder・single inferenceの
逐次throughputです。並列worker、WebSocket、browser packet展開、texture upload、
mesh描画、自動制御は含みません。GPU/codec/設定を1つずつ比較する用途には有効ですが、
end-to-endの最終結果はbrowser適用depth FPSで判断します。

### 4. チューニング指針

- Auto Balancedから始め、warmup完了を待ちます。
- Inference/throughput limiter: process resolutionを下げます。worker追加はGPU使用率と
  VRAMを確認してから行います。
- infer waitまたはqueue waitが高い: resolutionまたはinflightを減らします。
  過負荷queueへ要求を追加すると遅延が増えます。
- decodeが高い: many-core CPUでdecoder workerを慎重に増やします。storage帯域が十分でも
  seekとcodec複雑度が律速になることがあります。
- 2K/4Kやanamorphic sourceでnormalizeが高い: process resolutionを下げます。
  事前縮小とsquare-pixel正規化の処理pixel数が減ります。
- packまたはpayloadが高い: log8、depth downsampleを使い、localhostでは実測上の
  利点がない限りzlibを無効にします。
- sendまたは残差RTTが高い: RGB画質を下げる前にdepth転送精度と空間解像度を下げます。
- backendが十分速いのにbrowser/render FPSが低い: SmoothまたはBalancedでmeshとdepth
  grid上限を同時に下げます。

一度に1項目だけ変更し、cold 1 frameではなくwarm状態のp50/p95を比較してください。

### 5. 表示幾何と奥行き安全処理

次の処理は3Dの正確性と視覚安定性を守ります。DA3推論速度制御ではありませんが、
FPSを損なわないようboundedな処理で実装しています。

- pinhole再構成はThree.jsとRawXRで共通の正規化`fx`、`fy`、`cx`、`cy`を使います。
  転送解像度が変わってもsource rayは変化しません。
- Auto Source Viewは校正source境界をfitし、配置sliderの所有者を一つにします。
  SBSはmeshを時間変化で移動せず、固定IPD off-axis frustumを使います。
- 接続meshはdepth不連続部を黒い亀裂として切断せず、近傍色を持つ遷移面として描きます。
- Looking GlassはRawXRを再利用し、明示entry時だけruntimeをloadします。wheel zoomとpanは
  projectionだけを変え、操作中のvendor config更新やquilt再確保を避けます。
- Looking Glass Source Viewは、Hologram Zoomとpan後に実際に見えているsource領域へ
  小さなprojection guard bandを加え、その範囲内へ固定2,048 sample予算を割り当てます。
  viewportのq1/q10/q20統計を通常収束、到達可能depthへのrebase、foreground回復に使い、
  有効sampleが不足する場合は推測せず直前のtargetを保持します。crop表示時はvendorの
  near-plane保護用にfull-frame q1を別途維持するため、2回目のsparse走査が発生することが
  あります。clickで選んだfocusは通常の動きではResume Autoまで固定し、scene切り替えや
  危険なforegroundでは自動解除できます。通常収束range外sceneにはsource apex中心の
  uniform depth変換を行い、source rayと四辺直線を維持します。

各規則はmode別に制限され、monitor、SBS、generic WebXR、Looking Glass Source View、
creative/free-orbitが互換性のない配置処理を暗黙共有しないようにしています。

### 6. 現在の性能上の制限

- 推論workerは設定値であり、runtimeで自動検出・増減しません。
- PyAVは現在software decodeで、hardware video decodeは未統合です。
- log8展開と`Float32Array`生成はbrowser main threadで行います。
- 自動品質変更で転送寸法が変わるとdepth texture objectを再生成します。
- 同梱benchmarkは逐次計測で、interactive end-to-end FPSとして扱えません。
