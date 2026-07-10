# VideoDepthViewer3D

<img width="640" height="315" alt="Image" src="https://github.com/user-attachments/assets/10e55ad5-8b03-4f62-bf6a-b5a04076d700" />
<img width="640" height="360" alt="Image" src="https://github.com/user-attachments/assets/4dad8ba1-206a-4301-87b4-af9b5db320bb" />

---

[English](#english) | [日本語](#japanese)

---

<a name="english"></a>
## English

### Overview
VideoDepthViewer3D is a high-performance streaming MP4 depth viewer. It decodes uploaded videos on the backend, generates metric depth maps in real time using [**Depth Anything 3 (DA3METRIC-LARGE)**](https://github.com/ByteDance-Seed/Depth-Anything-3), and streams them to a Three.js/WebXR frontend via WebSocket.

### System Architecture
- **Backend (FastAPI + PyAV + PyTorch)**
  - **DecoderPool:** Parallel PyAV decoders to avoid serial decode bottlenecks.
  - **Inference workers:** Configurable Depth Anything 3 workers (default 3) so multiple frames process concurrently.
  - **Display calibration:** Container rotation and sample-aspect ratio are normalized to the browser's display coordinates before inference. DA3Metric focal scaling uses the actual processed dimensions, so automatic resolution changes do not change scene scale.
  - **Flow control:** A bounded dropping queue removes stale requests to prevent latency buildup.
  - **WebSocket stream:** Depth maps use versioned linear16/log8 packets, are capped to useful inference detail, and are sent as soon as each pipeline completes.
- **Frontend (Vite + Three.js/WebXR)**
  - **DepthBuffer:** Manages sync, handles jitter, and re-requests missing frames.
  - **Mesh generation:** Grid mesh can be reconstructed either as a classic relief mesh or with pinhole-style reprojection. The default is now **pinhole**.
  - **Shared viewer controls:** The same projection/depth controls drive both the normal Three.js path and the RawXR mesh path.
  - **WebXR:** RawXR path renders the same reconstructed mesh to both eyes; Three.js XR is disabled (experimental VR).

### Setup & Run
1. **Install dependencies (uv):**
   ```bash
   uv venv .venv
   uv sync --locked --extra dev --extra inference
   ```

2. **One-click Run (Recommended):**
   ```bash
   ./start.sh
   ```
   This starts both the backend (port 8000) and frontend (port 5173).
   
   > [!NOTE]
   > **First Run:** On the very first run, the application will download the Depth Anything 3 model (**approx. 1.3GB**). This may take some time. Please check the console for progress. Model loading is single-flight and cold-start samples are excluded from automatic tuning; a restart is not normally required.

   > [!IMPORTANT]
   > **Restarting the App:** Stop the existing `start.sh` with Ctrl+C before starting another copy. The frontend uses a strict port so an occupied port 5173 fails visibly instead of silently starting a second server on 5174. Refresh the browser after the new process is ready.

3. **Manual Run (Alternative):**
   - **Backend:**
     ```bash
     VIDEO_DEPTH_INFER_WORKERS=4 VIDEO_DEPTH_DOWNSAMPLE=4 UV_CACHE_DIR=.uv-cache DA3_LOG_LEVEL=WARN \
     uv run --locked --extra inference python3 scripts/run_backend.py
     ```
   - **Frontend:**
     ```bash
     cd webapp
     npm ci
     npm run dev
     ```
   Then open `http://localhost:5173`.

### Video Source and Local Cache
`Open Video` currently serves two consumers: the browser plays the selected file
directly, and the Python backend receives a 1 MiB-at-a-time copy at
`tmp/sessions/<session-id>/source.mp4` for seekable PyAV decoding. On localhost
this is a local process transfer, not an upload to an external service, and the
whole video is not buffered in application RAM. Before a new default-root
session is created, older session directories are removed, so only the latest
source copy remains until replacement or explicit deletion. A no-copy trusted
local-path mode is not implemented yet.

The shipped configuration is localhost-first: HTTP loopback needs no certificate
and avoids a physical-network source transfer. Remote use requires an explicit
frontend API address and CORS configuration; WebXR deployments on non-loopback
hosts also normally require HTTPS/WSS, and network latency/bandwidth become part
of the recurring depth-stream budget.

### Display Modes
- **Normal (PC 2D/3D):** Three.js draws video + depth mesh on the page.
- **SBS Stereo (0DOF):** Side-by-side split with off-axis eye frusta and an explicit convergence plane. You can optionally swap left/right eyes with the `Swap L/R` checkbox.
- **VR (RawXR):** Starts WebXR and renders the depth mesh to both eyes via the RawXR pipeline (experimental).

### Viewer Controls
- **Projection:** `pinhole` is the geometry-correct default. `relief` remains available as a creative/compatibility mode.
- **Framing:** `Auto Source View` is the default for pinhole geometry. It places the monitor eye at the reconstructed source-camera origin and uses a sparsely sampled central depth median as the orbit pivot. It automatically fits all source-camera boundaries into the active viewport; SBS uses the aspect of each half plus a small parallax margin, so both eyes retain the full source image. This prevents the default view from exaggerating the camera frustum into a fan. Mouse orbit/zoom or manual placement switches to `Free Orbit`; select `Auto Source View` again or double-click the canvas to reset.
- **Min View FOV Y / Source FOV Y:** Min View FOV is a zoom-out floor and can be changed without leaving Auto Source View. Auto-fit may select a wider effective FOV for a narrow monitor or SBS half. In Free Orbit it is the normal display-camera FOV. Source FOV controls fallback source calibration; when a video has no K metadata, changing it updates inverse projection, metric focal scale, and auto-fit together.
- **Orbit Distance / Model Z Offset:** In Auto Source View these report the same automatically selected pivot depth and are disabled because Source View owns placement. Select Free Orbit (or navigate the canvas) to enable them. Orbit distance stays positive while Model Z is a signed translation, so their lower bounds intentionally differ. These controls do not change backend throughput.
- **Manual target tris:** Advanced control for mesh density. The grid stays fully connected; depth discontinuities are rendered as locally textured surfaces instead of black cracks.
- **Z Scale / Z Bias / Z Gamma / Plane Scale:** Creative shaping controls used by `relief`. In `pinhole`, metric scale, zero bias, linear depth, and exact K-based projection are enforced. **Z Max Clip / Y Offset** remain safety/rigid-placement controls.

RawXR applies the same origin rule at session entry: the source-camera origin is
anchored once at the midpoint of the initial XR views. The anchor then stays
fixed so later XR view motion produces parallax rather than a
head-locked surface.

### Automatic Performance Modes
- **Auto Smooth:** Targets 30 applied depth FPS and starts with the smallest depth raster and mesh-density budget.
- **Auto Balanced (default):** Targets 30 applied depth FPS with a medium depth raster and log8 transport.
- **Auto Quality:** Targets 24 FPS, starts at the configured maximum inference resolution and linear16, then reduces precision before spatial quality when the network is limiting.
- **Manual / Creative:** Disables automatic quality changes and honors the backend environment settings and manual mesh-density slider.

Automatic targets are capped by the source FPS. The controller feeds back unique
depth frames actually applied by the browser, separates model execution from
inference-slot wait, and subtracts measured server work from end-to-end RTT
before declaring a network limit. Compute pressure lowers inference resolution;
transport pressure spends encoding/downsampling. Completed pipelines are sent
immediately and sorted by timestamp in the browser, avoiding head-of-line stalls.
RGB video remains at browser-native quality, and focal correction prevents
quality transitions from changing metric scale. Log8 uses one byte per depth
sample with logarithmic spacing, half the uncompressed linear16 payload.

### Configuration
You can tune performance via backend environment variables and frontend URL parameters.

For a full breakdown of optimization strategies and telemetry knobs, see [`OPTIMIZATION_DETAILS.md`](OPTIMIZATION_DETAILS.md).

**Backend Environment Variables:**

| Variable | Default | Description |
| :--- | :--- | :--- |
| `VIDEO_DEPTH_INFER_WORKERS` | `3` | Concurrent inference tasks. Increase only after verifying GPU/VRAM headroom. |
| `VIDEO_DEPTH_DECODER_WORKERS` | `4` | Parallel software decoders. Increase carefully on many-core CPUs; each decoder also uses FFmpeg frame/slice threads. |
| `VIDEO_DEPTH_DOWNSAMPLE` | `1` | Depth downsample factor. Set **2 or 4** to reduce bandwidth and raise FPS. |
| `VIDEO_DEPTH_PROCESS_RES` | `640` | Max inference resolution. Lower (e.g., 384) for speed at cost of detail. |
| `VIDEO_DEPTH_SOURCE_FOV_Y` | `50` | Fallback source vertical FOV when the video has no camera intrinsics. |
| `VIDEO_DEPTH_METRIC_REFERENCE_FOCAL_PX` | `300` | DA3Metric canonical focal reference. Change only for a model with a different convention. |
| `VIDEO_DEPTH_MODEL_ID` | `depth-anything/DA3METRIC-LARGE` | Hugging Face model ID. |
| `VIDEO_DEPTH_DEVICE` | `auto` | Selects CUDA/ROCm-compatible, Intel XPU, Apple MPS, then CPU. Set an explicit PyTorch device to override. |
| `VIDEO_DEPTH_CACHE` | `8` | Decoded frame cache size. |
| `VIDEO_DEPTH_COMPRESSION` | `0` | Zlib level (0–9). 0 recommended for low latency. |
| `VIDEO_DEPTH_ENCODING` | `log8` | Manual-mode transport: `log8` (half payload) or `linear16` (maximum precision). |
| `VIDEO_DEPTH_OPTIMIZATION_MODE` | `balanced` | Initial backend mode: `smooth`, `balanced`, `quality`, or `manual`. The frontend selection takes over when streaming starts. |
| `VIDEO_DEPTH_PROFILE_TIMING` | `False` | Enable detailed timing logs. |
| `VIDEO_DEPTH_LOG_LEVEL` | `WARNING` | Log level (DEBUG, INFO, WARNING, ERROR). Set to **INFO** to see stats. |
| `VIDEO_DEPTH_DATA_ROOT` | `tmp/sessions` | Cache root for backend source copies. The default root is cleared before a new session; custom roots require `VIDEO_DEPTH_CLEAR_CACHE=1` for automatic cleanup. |
| `VIDEO_DEPTH_CLEAR_CACHE` | `False` | Allow cache cleanup even when `VIDEO_DEPTH_DATA_ROOT` is not the default `tmp/sessions`. |
| `UV_CACHE_DIR` | – | uv cache path (e.g., `.uv-cache`) to avoid download timeouts. |

**Frontend URL Parameters:**
- `?maxInflight=N`: concurrent requests (default 8). Increase to **16–32** if RTT is low; decrease to **4–8** if RTT is high.
- `?debug=true`: Enable verbose logging (Health stats, Perf metrics) in browser console.

### Tests and Generated Media
The repository does not require checked-in or copyrighted test videos. With
FFmpeg and ffprobe available, generate the deterministic short fixture set and
run both test suites:

```bash
uv run --locked --extra dev python scripts/generate_test_media.py --profile fast
uv run --locked --extra dev pytest -q
cd webapp
npm ci
npm test
```

Generated videos and their probed `manifest.json` are written below
`tmp/test-media/`, which is ignored by Git. The `fast` profile covers CFR with
audio, anamorphic SAR, portrait video, rotation metadata, and VFR/B-frames. For
local resolution/FPS/codec sweeps (up to 4K and optional H.265/VP9/AV1), use:

```bash
uv run --locked --extra dev python scripts/generate_test_media.py --profile full
```

Unsupported optional encoders are reported as skipped. The fast H.264 cases are
required and generation fails visibly if they cannot be produced or probed.
The test suites also verify metric-scale invariance, known-K inverse projection,
off-axis stereo math, SAR display geometry, and rotation direction.

For an optional real-model hardware report (not part of CPU CI), run:

```bash
uv run --locked --extra dev --extra inference python scripts/benchmark_pipeline.py \
  --process-res 640 --downsample 2 --encoding log8 \
  --output tmp/benchmark-balanced.json
```

The JSON records hardware/software versions, warmup/measured frame counts,
per-frame data, p50/p95 stage latency, sequential FPS, metric focal scale, and
payload bandwidth. Pass `--video path/to/video.mp4` to benchmark private media
without adding it to the repository.

### Optimization Details
See [`OPTIMIZATION_DETAILS.md`](OPTIMIZATION_DETAILS.md) for optimization internals and telemetry.

### License & Acknowledgements
This project is licensed under the Apache License 2.0. See [LICENSE](LICENSE) for details.

- **Depth Anything 3**: This project utilizes the [Depth Anything 3](https://github.com/ByteDance-Seed/Depth-Anything-3) model for depth estimation. Depth Anything 3 is licensed under the Apache License 2.0.
- **Three.js**: Licensed under the MIT License.
- **FastAPI**: Licensed under the MIT License.


---

<a name="japanese"></a>
## 日本語

### 概要
VideoDepthViewer3D は、MP4 動画をリアルタイムに深度推定して 3D 表示するストリーミングビューアです。バックエンドで [**Depth Anything 3 (DA3METRIC-LARGE)**](https://github.com/ByteDance-Seed/Depth-Anything-3) を使って深度マップを生成し、WebSocket 経由で Three.js/WebXR フロントエンドに配信します。

### 仕組み（アーキテクチャ）
- **バックエンド (FastAPI + PyAV + PyTorch)**
  - **DecoderPool:** 複数の PyAV デコーダーで並列デコードし、デコード待ちのボトルネックを解消。
  - **推論ワーカー:** 設定可能な数（デフォルト 3）の Depth Anything 3 ワーカーで同時推論。
  - **表示校正:** コンテナの回転とSARをブラウザと同じ表示座標へ正規化してから推論します。DA3Metricの焦点距離補正には実際の処理解像度を使うため、自動解像度変更でシーン尺度が変化しません。
  - **フロー制御:** 上限付きdropping queueで古いrequestを除去し、遅延蓄積を防止。
  - **WebSocket ストリーム:** version付きlinear16/log8 packetを使い、有効な推論detailを上限にして、各pipelineの完成直後に送信。
- **フロントエンド (Vite + Three.js/WebXR)**
  - **DepthBuffer:** 同期管理と欠落フレーム再要求で滑らかな再生を維持。
  - **メッシュ生成:** グリッドメッシュを、従来の relief 方式または pinhole 方式で再構成できます。現在のデフォルトは **pinhole** です。
  - **共通ビューア設定:** 通常の Three.js 描画と RawXR のメッシュ描画は同じ投影/深度コントロールを共有します。
  - **WebXR:** RawXR (WebGL2) で両目に同じ再構成メッシュを描画。同期ズレや黒画面問題を解消。

### セットアップと実行
1. **依存関係のインストール (uv):**
   ```bash
   uv venv .venv
   uv sync --locked --extra dev --extra inference
   ```
2. **ワンクリック起動（推奨）:**
   ```bash
   ./start.sh
   ```
  このスクリプトは、バックエンド (port 8000) とフロントエンド (port 5173) の両方を起動します。

   > [!NOTE]
   > **初回起動時:** 初回実行時には Depth Anything 3 モデル（**約 1.3GB**）のダウンロードが発生するため、デプス推論の開始まで時間がかかります。進捗はコンソールを確認してください。model loadはsingle-flightで、cold-start sampleは自動調整から除外されるため、通常は再起動不要です。

   > [!IMPORTANT]
   > **アプリの再起動について:** 新しいcopyを起動する前に既存の`start.sh`をCtrl+Cで停止してください。frontendはstrict portを使うため、5173が使用中なら5174へ黙って二重起動せず明示的に失敗します。新processの準備後にbrowserをreloadしてください。

3. **バックエンド起動（高負荷向け例）:**
   ```bash
   VIDEO_DEPTH_INFER_WORKERS=4 VIDEO_DEPTH_DOWNSAMPLE=4 UV_CACHE_DIR=.uv-cache DA3_LOG_LEVEL=WARN \
   uv run --locked --extra inference python3 scripts/run_backend.py
   ```

3. **フロントエンド起動:**
   ```bash
   cd webapp
   npm ci
   npm run dev
   ```
   ブラウザで `http://localhost:5173` にアクセス。

### 動画sourceとlocal cache
`Open Video`は現在2つのconsumerへsourceを渡します。browserは選択fileを直接再生し、
Python backendはseek可能なPyAV decode用として同じ圧縮bytesを1 MiBずつ
`tmp/sessions/<session-id>/source.mp4`へcopyします。localhostでは外部serviceへの
uploadではなくlocal process間転送で、動画全体をapplication RAMへ保持しません。
default rootでは新session作成前に以前のsession directoryを削除するため、最新source
copyだけが次の置換または明示削除まで残ります。no-copyの信頼済みlocal-path modeは
まだ未実装です。

標準構成はlocalhost-firstです。HTTP loopbackは証明書不要で、物理networkを通る
source転送もありません。remote利用にはfrontend API addressとCORSの明示設定が必要で、
非loopback host上のWebXRは通常HTTPS/WSSも必要です。その場合はnetwork latency/bandwidthも
継続的なdepth stream budgetへ入ります。

### 表示モード
- **通常 (PC 2D/3D):** Three.js が動画と深度メッシュを描画。
- **SBS Stereo (0DOF):** 明示的な収束面を持つoff-axis投影によるサイドバイサイド立体視（頭トラッキングなし）。`Swap L/R` チェックで左右の目を入れ替えられます。
- **VR (RawXR):** WebXR を開始し、最適化されたパイプラインで描画。コントローラーで視点操作（オービット、パン、ズーム）が可能。（実験的段階）

### ビューア設定
- **Projection:** 幾何学的に正確なデフォルトは `pinhole` です。`relief` はクリエイティブ/互換モードとして残しています。
- **Framing:** `pinhole`では`Auto Source View`がデフォルトです。表示する目と再構成source camera原点を一致させ、画面/SBSの各片にsource全体が入るFOVへ自動fitします。canvas操作または明示的な選択で`Free Orbit`へ移り、再選択またはダブルクリックで戻せます。
- **Min View FOV Y / Source FOV Y:** Min View FOVはAuto Source Viewを解除しないzoom-out下限です。Source FOVはK情報がない動画のフォールバックsource校正で、逆投影・metric焦点倍率・auto-fitを同時に更新します。
- **Orbit Distance / Model Z Offset:** Auto Source Viewでは同じ自動pivot値を表示し、source側が配置を所有するため無効になります。Free Orbitへ切り替えると編集可能です。Orbit Distanceは正の半径、Model Zは符号付き移動なので下限は意図的に異なります。
- **Manual target tris:** mesh密度の高度な設定です。gridは常に連続させ、depth不連続部も黒い亀裂にせず近傍の動画色を持つ面として描画します。
- **Z Scale / Z Bias / Z Gamma / Plane Scale:** `relief`用のクリエイティブ整形パラメータです。`pinhole`ではmetric倍率、bias 0、線形depth、Kに基づく投影を固定します。**Z Max Clip / Y Offset** は安全制限/剛体配置として引き続き有効です。

### 自動パフォーマンスモード
- **Auto Smooth:** 適用済みdepth 30 FPSを目標に、最小のdepth rasterとmesh密度から開始します。
- **Auto Balanced（デフォルト）:** 30 FPSを目標に、中程度のdepth rasterとlog8転送を使います。
- **Auto Quality:** 24 FPSを目標に、設定上限の推論解像度とlinear16から開始し、ネットワークが律速すると空間解像度より先に精度を下げます。
- **Manual / Creative:** 自動変更を停止し、環境変数と手動mesh設定を尊重します。

目標FPSはsource FPSを上限にします。ブラウザで実際に適用できた固有depth FPSを
フィードバックし、model実行と推論slot待ちを分離し、end-to-end RTTからserver処理を
差し引いた残差だけをネットワーク判定に使います。計算律速では推論解像度、転送律速
ではencoding/downsampleを変更します。完成したdepthから即送信し、browser側で時刻順に
並べるためhead-of-line停止も避けます。RGB動画はbrowser本来の品質を維持し、焦点距離
補正により品質遷移でmetric尺度は変わりません。

### 設定一覧
環境変数（バックエンド）と URL パラメータ（フロントエンド）でパフォーマンスを調整できます。

最適化の仕組みや計測項目の詳しい解説は [`OPTIMIZATION_DETAILS.md`](OPTIMIZATION_DETAILS.md) を参照してください。

**バックエンド環境変数:**

| 変数名 | デフォルト | 説明 |
| :--- | :--- | :--- |
| `VIDEO_DEPTH_INFER_WORKERS` | `3` | 同時推論タスク数。GPU/VRAMの余裕を確認できた場合だけ増やしてください。 |
| `VIDEO_DEPTH_DECODER_WORKERS` | `4` | software decoder並列数。各decoderもFFmpeg内部threadを使うため、多core CPUで慎重に増やしてください。 |
| `VIDEO_DEPTH_DOWNSAMPLE` | `1` | 深度マップのダウンサンプル係数。**2 または 4** で帯域削減と FPS 向上。 |
| `VIDEO_DEPTH_PROCESS_RES` | `640` | 推論の最大解像度。値を下げると高速化するがディテール低下。 |
| `VIDEO_DEPTH_SOURCE_FOV_Y` | `50` | カメラ内部パラメータがない動画で使うsource垂直FOV。 |
| `VIDEO_DEPTH_METRIC_REFERENCE_FOCAL_PX` | `300` | DA3Metricの基準焦点距離。異なる規約のモデル以外では変更不要。 |
| `VIDEO_DEPTH_MODEL_ID` | `depth-anything/DA3METRIC-LARGE` | Hugging Face のモデル ID。 |
| `VIDEO_DEPTH_DEVICE` | `auto` | CUDA/ROCm互換、Intel XPU、Apple MPS、CPUの順に自動選択。PyTorch deviceを明示して上書き可能。 |
| `VIDEO_DEPTH_CACHE` | `8` | デコード済みフレームのキャッシュ数。 |
| `VIDEO_DEPTH_COMPRESSION` | `0` | Zlib 圧縮レベル（0–9）。低遅延のため **0（無効）** を推奨。 |
| `VIDEO_DEPTH_ENCODING` | `log8` | Manualモードの転送形式。`log8`（半分の転送量）または`linear16`（最大精度）。 |
| `VIDEO_DEPTH_OPTIMIZATION_MODE` | `balanced` | 初期モード。`smooth`、`balanced`、`quality`、`manual`。ストリーミング開始後はフロントエンド選択が優先されます。 |
| `VIDEO_DEPTH_PROFILE_TIMING` | `False` | 詳細なタイミングログを有効化。 |
| `VIDEO_DEPTH_LOG_LEVEL` | `WARNING` | log level（DEBUG、INFO、WARNING、ERROR）。統計表示には`INFO`を使用。 |
| `VIDEO_DEPTH_DATA_ROOT` | `tmp/sessions` | backend source copyのroot。default rootは新session前に削除され、custom rootの自動削除には`VIDEO_DEPTH_CLEAR_CACHE=1`が必要です。 |
| `VIDEO_DEPTH_CLEAR_CACHE` | `False` | `VIDEO_DEPTH_DATA_ROOT` がデフォルト以外でもキャッシュ削除を許可します。 |
| `UV_CACHE_DIR` | – | uv のキャッシュパス（例: `.uv-cache`）。ダウンロード失敗を防止。 |

**フロントエンド URL パラメータ:**
- `?maxInflight=N`: 同時リクエスト数の上限（デフォルト 8）。RTT が小さければ **16〜32**、大きければ **4〜8** へ。

### テストと自動生成動画
著作権のあるテスト動画をリポジトリへ同梱する必要はありません。
FFmpeg と ffprobe が利用できる環境で、短い決定論的fixtureとテストを次のように実行できます。

```bash
uv run --locked --extra dev python scripts/generate_test_media.py --profile fast
uv run --locked --extra dev pytest -q
cd webapp
npm ci
npm test
```

生成動画と実測メタデータの `manifest.json` は、Git対象外の
`tmp/test-media/` に保存されます。`fast` は音声付きCFR、アナモルフィック
SAR、縦動画、回転メタデータ、VFR/B-frameを網羅します。4Kまでの解像度、
24/30/60fps、H.264/H.265/VP9/AV1をローカルで比較する場合は次を使います。

```bash
uv run --locked --extra dev python scripts/generate_test_media.py --profile full
```

任意コーデックのエンコーダーがない場合はskip理由を表示します。fastの
H.264ケースは必須で、生成またはffprobe検証に失敗した場合は明示的に失敗します。
テストではmetric尺度不変性、既知Kの逆投影、off-axis stereo数式、SAR表示寸法、回転方向も検証します。

実モデルを使う任意のハードウェア計測（CPU CI対象外）は次で実行できます。

```bash
uv run --locked --extra dev --extra inference python scripts/benchmark_pipeline.py \
  --process-res 640 --downsample 2 --encoding log8 \
  --output tmp/benchmark-balanced.json
```

JSONにはハードウェア/ソフトウェア版、warmup/計測frame数、frame別データ、
stage別p50/p95、逐次FPS、metric焦点倍率、payload帯域が記録されます。
`--video path/to/video.mp4`で非公開動画もリポジトリへ追加せず計測できます。

### 最適化ドキュメント
最適化の仕組みや計測項目の詳しい解説は [`OPTIMIZATION_DETAILS.md`](OPTIMIZATION_DETAILS.md) を参照してください。

### License & Acknowledgements
This project is licensed under the Apache License 2.0. See [LICENSE](LICENSE) for details.

- **Depth Anything 3**: This project utilizes the [Depth Anything 3](https://github.com/ByteDance-Seed/Depth-Anything-3) model for depth estimation. Depth Anything 3 is licensed under the Apache License 2.0.
- **Three.js**: Licensed under the MIT License.
- **FastAPI**: Licensed under the MIT License.
