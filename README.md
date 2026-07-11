# VideoDepthViewer3D

<img width="640" height="315" alt="Image" src="https://github.com/user-attachments/assets/10e55ad5-8b03-4f62-bf6a-b5a04076d700" />
<img width="640" height="360" alt="Image" src="https://github.com/user-attachments/assets/4dad8ba1-206a-4301-87b4-af9b5db320bb" />

---

[English](#english) | [日本語](#japanese)

---

<a name="english"></a>
## English

### Overview
VideoDepthViewer3D turns an MP4 video into an interactive 3D view in real time.
The browser plays the original video while a local Python process estimates
depth with [**Depth Anything 3 (DA3METRIC-LARGE)**](https://github.com/ByteDance-Seed/Depth-Anything-3).
You can view the result on a normal monitor, in side-by-side stereo, with
WebXR, or on a Looking Glass display.

### How it works

- The browser displays the original video at its native quality.
- The local backend estimates depth and sends only the depth result to the
  viewer.
- The viewer reconstructs a 3D surface and keeps it synchronized with the
  video.
- Automatic performance modes adjust depth quality for the available GPU, CPU,
  and connection while prioritizing smooth playback.

See [`OPTIMIZATION_DETAILS.md`](OPTIMIZATION_DETAILS.md) for implementation,
calibration, and performance-measurement details.

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

   `start.sh` is for Linux, macOS, WSL, or Git Bash. On native Windows
   PowerShell, use the two portable commands under **Manual Run** below in
   separate terminals.
   
   > [!NOTE]
   > **First Run:** The application downloads the Depth Anything 3 model
   > (**approximately 1.3 GB**). Depth processing starts after the download and
   > model loading finish, so please allow some extra time.

   > [!IMPORTANT]
   > **Restarting the App:** Stop the existing `start.sh` with Ctrl+C before
   > starting it again. Only run one copy at a time. The browser app always uses
   > port 5173; refresh the page after the restarted app is ready.

3. **Manual Run (Alternative):**
   - **Backend:**
     ```bash
     uv run --locked --extra inference python scripts/run_backend.py
     ```
   - **Frontend:**
     ```bash
     cd webapp
     npm ci
     npm run dev
     ```
   Then open `http://localhost:5173`.

Both development servers bind to the local computer by default. Deliberately
binding them to another interface is an advanced remote-access configuration
and requires appropriate network security.

### Using a Looking Glass

#### What you need

- A Looking Glass connected and enabled as a desktop display.
- [Looking Glass Bridge](https://lookingglassfactory.com/software/looking-glass-bridge)
  installed for Windows, macOS, or Linux.
- Chrome or another Chromium-based browser is recommended. Firefox can also be
  used, but you may need to move the presentation window to the Looking Glass
  yourself. Safari is not supported.

On a Windows host, use the native Windows setup for Looking Glass (Bridge,
browser, frontend, and backend) rather than WSL. Generic WebXR headsets such as
Meta Quest through Meta Quest Link are different: the Windows browser and XR
runtime own the headset session, so the application servers may run either
natively on Windows or in WSL as long as the page is opened in the Windows
browser through `localhost`.

#### Start in this order

1. Connect and turn on the Looking Glass.
2. Start **Looking Glass Bridge** and wait until it recognizes the display.
   Leave Bridge running while you use the viewer.
3. Start VideoDepthViewer3D using the setup instructions above (`./start.sh`
   on Bash, or the manual commands on Windows PowerShell), then open
   `http://localhost:5173`. For the most reliable startup, Bridge should already
   be running before this page is opened or reloaded.
4. Select **Open Video**. Wait until both the video and the 3D view are moving
   in the browser. The first run takes longer while the depth model is
   downloaded and loaded.
5. Select **Enter Looking Glass** and allow the browser to open and place the
   presentation window. If the browser does not place it automatically, move
   that window to the Looking Glass display.
6. The status changes to **Active** when the device is ready. Select
   **Exit Looking Glass** to return to normal monitor viewing.

On macOS, keep the browser in a normal desktop window rather than macOS
full-screen mode while starting Looking Glass, so the presentation window can
open on the external display.

#### Looking Glass controls

- **Mouse wheel / Hologram Zoom:** Zoom the hologram without changing its
  focus. Scrolling back through 1× returns to the fitted full-video size.
- **Drag with either mouse button:** Pan the image. This does not rotate the
  scene.
- **Click without dragging:** Use the selected point as the depth focus. Zoom
  stays unchanged, so zooming remains under your control.
- **Auto Depth Placement:** Recommended and enabled by default. It follows
  scene changes, brings distant scenes forward, and moves excessively close
  content back to keep it visible.
- **Focus Trim:** Fine-tune depth placement after automatic placement or a
  click.
- **Reset Zoom / Pan:** Restore the fitted size and centered position.

`Auto Source View` is the recommended framing mode. It fits the complete video
into the connected display and keeps the video borders straight. A wide video
on a portrait device such as Looking Glass Go is therefore shown with empty
space above and below; this is expected and avoids cropping the source.

#### Troubleshooting

- **Bridge unavailable:** Start Looking Glass Bridge, confirm that it detects
  the display, then select **Enter Looking Glass** again.
- **Blocked:** Allow pop-ups and window-management permission for
  `localhost:5173`, then try again. On macOS, also leave browser full-screen
  mode.
- **Unverified:** The presentation window opened, but device calibration was
  not received. Check the video/USB connections and confirm that Bridge sees
  the display.
- **Black, stale, or incorrectly placed image:** Select **Exit Looking Glass**,
  make sure Bridge is already running, hard-reload the browser page
  (Ctrl+Shift+R on Windows/Linux or Cmd+Shift+R on macOS), reopen the video,
  wait until the video and 3D view are moving, and enter Looking Glass again.
- **Image is too large or off-center:** Scroll out or select
  **Reset Zoom / Pan**. Keep **Auto Depth Placement** enabled unless you want to
  hold a manually selected focus.
- After using Looking Glass, reload the page before starting the experimental
  generic VR mode.

Implementation and calibration details are kept in
[`OPTIMIZATION_DETAILS.md`](OPTIMIZATION_DETAILS.md).

### Video Source and Local Cache
When you select **Open Video**, the browser plays the selected file and makes a
temporary copy available to the local Python backend for depth processing. With
the standard `localhost` setup, the video does not leave your computer and is
not uploaded to an external service. The application does not keep the entire
video in RAM.

Temporary source files are stored below `tmp/sessions/`. In the standard setup,
an older session is removed when a new one is created, so only the latest source
copy remains. If you configure the frontend and backend on different computers,
the source must cross that network and additional server/security configuration
is required.

### Display Modes
- **Normal (PC 2D/3D):** Three.js draws video + depth mesh on the page.
- **SBS Stereo (0DOF):** Shows left- and right-eye images side by side without
  head tracking. Use `Swap L/R` if the eye order is reversed on your display.
- **VR:** Shows the 3D video in a WebXR headset. This mode is experimental.
- **Looking Glass:** Sends the reconstructed video to a connected Looking Glass.
  See [Using a Looking Glass](#using-a-looking-glass) for setup, controls, and
  troubleshooting.

### Viewer Controls
- **Projection:** Keep `pinhole` for the most natural geometry. Use `relief` only
  when you want a stylized or compatibility view.
- **Framing:** `Auto Source View` is the recommended default. It fits the whole
  source and avoids the fan-shaped look caused by an unsuitable camera position.
  The wheel zooms around the pointer, either mouse button can drag to pan, and a
  double-click resets zoom and pan. Select `Free Orbit` when you want to rotate
  the scene.
- **Min View FOV Y / Source FOV Y:** These are advanced lens/framing controls.
  Most videos should be left at their automatic/default values.
- **Orbit Distance / Model Z Offset:** Auto Source View manages these values and
  disables their sliders. Select `Free Orbit` to place the camera and model
  manually.
- **Looking Glass:** Use the dedicated controls described in
  [Using a Looking Glass](#looking-glass-controls). The default automatic
  framing and depth placement are recommended for normal viewing.
- **Manual target tris:** Advanced mesh-density control. Higher values can show
  more depth detail but require more GPU work.
- **Creative controls:** `Z Scale`, `Z Bias`, `Z Gamma`, and `Plane Scale` shape
  the stylized `relief` view. They are not needed for the recommended `pinhole`
  mode.

### Automatic Performance Modes
- **Auto Smooth:** Targets 30 applied depth FPS and starts with the smallest depth raster and mesh-density budget.
- **Auto Balanced (default):** Targets 30 applied depth FPS with a medium depth raster and log8 transport.
- **Auto Quality:** Targets 24 FPS, starts at the configured maximum inference resolution and linear16, then reduces precision before spatial quality when the network is limiting.
- **Manual / Creative:** Disables automatic quality changes and honors the backend environment settings and manual mesh-density slider.

`Auto Balanced` is the recommended starting point. Automatic modes adjust depth
resolution, transfer size, and mesh density to keep playback smooth; they do not
reduce the original RGB video's browser playback quality. The achieved depth
FPS cannot exceed the source video's FPS. Use `Manual / Creative` only when you
want to tune the advanced controls yourself.

### Advanced Configuration
Most users should start with `Auto Balanced` and leave these values unchanged.
For manual tuning, you can use backend environment variables and frontend URL
parameters.

For a full breakdown of optimization strategies and telemetry knobs, see [`OPTIMIZATION_DETAILS.md`](OPTIMIZATION_DETAILS.md).

**Backend Environment Variables:**

| Variable | Default | Description |
| :--- | :--- | :--- |
| `VIDEO_DEPTH_INFER_WORKERS` | Windows: `2`; others: `3` | Concurrent inference tasks. Increase only after verifying GPU/VRAM headroom. |
| `VIDEO_DEPTH_DECODER_WORKERS` | `4` | Parallel software decoders. Increase carefully on many-core CPUs; each decoder also uses FFmpeg frame/slice threads. |
| `VIDEO_DEPTH_DOWNSAMPLE` | `1` | Depth downsample factor. Set **2 or 4** to reduce bandwidth and raise FPS. |
| `VIDEO_DEPTH_PROCESS_RES` | `640` | Max inference resolution. Lower (e.g., 384) for speed at cost of detail. |
| `VIDEO_DEPTH_SOURCE_FOV_Y` | `50` | Fallback source vertical FOV when the video has no camera intrinsics. |
| `VIDEO_DEPTH_METRIC_REFERENCE_FOCAL_PX` | `300` | DA3Metric canonical focal reference. Change only for a model with a different convention. |
| `VIDEO_DEPTH_MODEL_ID` | `depth-anything/DA3METRIC-LARGE` | Hugging Face model ID. |
| `VIDEO_DEPTH_DEVICE` | `auto` | Selects CUDA/ROCm-compatible, Intel XPU, Apple MPS, then CPU. Set an explicit PyTorch device to override. |
| `VIDEO_DEPTH_HOST` | `127.0.0.1` | Backend bind address. Keep the loopback default for normal local use. |
| `VIDEO_DEPTH_PORT` | `8000` | Backend listen port. |
| `VIDEO_DEPTH_CACHE` | `8` | Recent inferred-depth result cache size. |
| `VIDEO_DEPTH_COMPRESSION` | `0` | Zlib level (0–9). 0 disables compression and is recommended for localhost latency. |
| `VIDEO_DEPTH_ENCODING` | `log8` | Manual-mode transport: `log8` (half payload) or `linear16` (maximum precision). |
| `VIDEO_DEPTH_OPTIMIZATION_MODE` | `balanced` | Initial backend mode: `smooth`, `balanced`, `quality`, or `manual`. The frontend selection takes over when streaming starts. |
| `VIDEO_DEPTH_PROFILE_TIMING` | `False` | Enable detailed timing logs. |
| `VIDEO_DEPTH_LOG_LEVEL` | `WARNING` | Log level (DEBUG, INFO, WARNING, ERROR). Set to **INFO** to see stats. |
| `DA3_LOG_LEVEL` | `WARN` | Depth Anything 3 log level. Set to **INFO** only when per-frame inference diagnostics are needed. |
| `VIDEO_DEPTH_DATA_ROOT` | `tmp/sessions` | Cache root for backend source copies. The default root is cleared before a new session; custom roots require `VIDEO_DEPTH_CLEAR_CACHE=1` for automatic cleanup. |
| `VIDEO_DEPTH_CLEAR_CACHE` | `False` | Allow cache cleanup even when `VIDEO_DEPTH_DATA_ROOT` is not the default `tmp/sessions`. |
| `UV_CACHE_DIR` | – | uv cache path (e.g., `.uv-cache`) to avoid download timeouts. |

**Frontend URL Parameters:**
- `?maxInflight=N`: initial/manual concurrent-request limit (default 8). Automatic modes replace it from the inference-worker count.
- `?debug=true`: Enable verbose logging (Health stats, Perf metrics) in browser console.

### Tests and Generated Media for Contributors
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
VideoDepthViewer3Dは、MP4動画をリアルタイムで立体表示するビューアです。
ブラウザで元動画を再生しながら、ローカルのPythonプロセスが
[**Depth Anything 3 (DA3METRIC-LARGE)**](https://github.com/ByteDance-Seed/Depth-Anything-3)
で奥行きを推定します。通常のモニター、SBS立体視、WebXR、Looking Glassで
結果を表示できます。

### 仕組み

- ブラウザは元動画を本来の画質で表示します。
- ローカルのバックエンドが奥行きを推定し、深度データだけをビューアへ渡します。
- ビューアは動画と同期する3Dの面を組み立てます。
- 自動パフォーマンスモードが、使用中のGPU、CPU、通信環境に合わせて深度品質を
  調整し、滑らかな再生を優先します。

実装、校正、性能計測の詳細は
[`OPTIMIZATION_DETAILS.md`](OPTIMIZATION_DETAILS.md)を参照してください。

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

   `start.sh`はLinux、macOS、WSL、Git Bash用です。WindowsのPowerShellから
   直接起動する場合は、下記の**個別に起動する場合**にある2つのコマンドを
   別々のターミナルで実行してください。

   > [!NOTE]
   > **初回起動時:** Depth Anything 3モデル（**約1.3 GB**）をダウンロードします。
   > ダウンロードとモデル読み込みが終わってから深度処理が始まるため、少し時間が
   > かかります。

   > [!IMPORTANT]
   > **アプリの再起動について:** 先に実行中の`start.sh`をCtrl+Cで停止してから、
   > もう一度起動してください。複数同時に起動しないでください。ブラウザ画面は常に
   > 5173番ポートを使うため、再起動後にページを更新します。

3. **個別に起動する場合:**
   - **バックエンド:**
     ```bash
     uv run --locked --extra inference python scripts/run_backend.py
     ```
   - **フロントエンド:**
     ```bash
     cd webapp
     npm ci
     npm run dev
     ```
   ブラウザで `http://localhost:5173` にアクセスします。

バックエンドとフロントエンドは、デフォルトではこのPCからだけ接続できるアドレスへ
bindします。別のPCへ公開する設定は高度なリモート利用となり、適切なネットワーク
セキュリティが必要です。

<a name="using-looking-glass-ja"></a>
### Looking Glassで使う

#### 必要なもの

- デスクトップディスプレイとして接続・有効化したLooking Glass。
- Windows、macOS、Linux用の
  [Looking Glass Bridge](https://lookingglassfactory.com/software/looking-glass-bridge)。
- ChromeなどのChromium系ブラウザを推奨します。Firefoxも利用できますが、
  表示用ウィンドウを自分でLooking Glassへ移動する必要がある場合があります。
  Safariには対応していません。

Windows上でLooking Glassを使う場合は、WSLではなく、Bridge、ブラウザ、フロント
エンド、バックエンドをWindowsネイティブで起動する構成を使用してください。
Meta Quest Linkなどの一般的なWebXRは、Windows側のブラウザとXRランタイムが
ヘッドセットとのセッションを担当します。そのため、アプリのサーバーはWindowsと
WSLのどちらで起動しても、Windows側ブラウザから`localhost`でページを開けば利用
できます。

#### この順番で起動してください

1. Looking Glassを接続して電源を入れます。
2. **Looking Glass Bridge**を起動し、ディスプレイが認識されるまで待ちます。
   ビューアの使用中はBridgeを終了しないでください。
3. 上記のセットアップ手順（Bashでは`./start.sh`、Windows PowerShellでは個別起動）で
   VideoDepthViewer3Dを起動し、`http://localhost:5173`を開きます。安定して
   起動するため、ブラウザでページを開く、または再読み込みする前にBridgeを
   起動しておくことを推奨します。
4. **Open Video**で動画を選びます。ブラウザ上で動画と3D表示の両方が
   動き始めるまで待ってください。初回は深度モデルのダウンロードと読み込みに
   時間がかかります。
5. **Enter Looking Glass**を選び、ブラウザのポップアップとウィンドウ配置を
   許可します。自動配置されない場合は、開いた表示用ウィンドウをLooking Glassへ
   移動してください。
6. デバイスの準備が完了するとステータスが**Active**になります。
   **Exit Looking Glass**で通常のモニター表示へ戻れます。

macOSでは、Looking Glassを開始するときにブラウザをmacOSのフルスクリーン表示に
せず、通常のデスクトップウィンドウで使用してください。外部ディスプレイへ表示用
ウィンドウを開けるようになります。

#### Looking Glassの操作

- **マウスホイール / Hologram Zoom:** ピント位置を変えずに拡大・縮小します。
  1×を通過するように戻すと、動画全体が入る初期サイズに合わせやすくなります。
- **左右どちらかのボタンでドラッグ:** 表示位置を上下左右へ移動します。
  シーンは回転しません。
- **ドラッグせずにクリック:** 選んだ点を奥行きの基準（ピント位置）にします。
  ズームは変わらないため、拡大率はホイールで独立して調整できます。
- **Auto Depth Placement:** デフォルトのまま有効にすることを推奨します。
  シーン切り替えに追従し、遠いシーンを手前へ寄せ、近すぎる部分を見える範囲へ
  戻します。
- **Focus Trim:** 自動配置またはクリック後の奥行きを微調整します。
- **Reset Zoom / Pan:** 拡大率と表示位置を初期状態へ戻します。

通常は`Auto Source View`を推奨します。接続したディスプレイに動画全体を収め、
動画の四辺をまっすぐに保ちます。Looking Glass Goのような縦長デバイスで横長動画を
表示すると上下に余白ができますが、元動画を切り取らずに全体を表示するための正常な
動作です。

#### 困ったときは

- **Bridge unavailable:** Looking Glass Bridgeを起動し、デバイスが認識されている
  ことを確認してから、もう一度**Enter Looking Glass**を選びます。
- **Blocked:** `localhost:5173`のポップアップとウィンドウ管理を許可してから
  再試行します。macOSではブラウザのフルスクリーン表示も解除してください。
- **Unverified:** 表示用ウィンドウは開きましたが、デバイスの情報を取得できて
  いません。映像・USBケーブルと、Bridge上のデバイス認識を確認してください。
- **真っ黒、更新されない、位置がおかしい:** **Exit Looking Glass**を選び、Bridgeが
  起動済みであることを確認してブラウザをハードリロードします（Windows/Linuxは
  Ctrl+Shift+R、macOSはCmd+Shift+R）。動画をもう一度開き、動画と3D表示の両方が
  動き始めてからLooking Glassへ入り直してください。
- **大きすぎる、または中央からずれた:** ホイールで縮小するか、
  **Reset Zoom / Pan**を選びます。手動でピントを固定したい場合を除き、
  **Auto Depth Placement**は有効のままにしてください。
- Looking Glassを使用した後に実験的な通常VRモードを開始する場合は、先にページを
  再読み込みしてください。

内部の実装や校正方法は
[`OPTIMIZATION_DETAILS.md`](OPTIMIZATION_DETAILS.md)にまとめています。

### 動画と一時ファイル
**Open Video**で動画を選ぶと、ブラウザが元動画を再生し、深度処理用の一時コピーを
ローカルのPythonバックエンドへ渡します。標準の`localhost`構成では、動画がPCの外や
外部サービスへアップロードされることはありません。動画全体をメモリへ保持する
方式でもありません。

一時ファイルは`tmp/sessions/`以下に保存されます。標準構成では、新しいセッションの
開始時に以前のセッションを削除するため、最新の動画コピーだけが残ります。
フロントエンドとバックエンドを別のPCで動かすように設定した場合は、動画がその
ネットワークを通り、追加のサーバー・セキュリティ設定も必要になります。

### 表示モード
- **通常 (PC 2D/3D):** Three.js が動画と深度メッシュを描画。
- **SBS Stereo (0DOF):** 左目用と右目用の映像を横に並べます。頭の動きには
  追従しません。左右が逆に見える場合は`Swap L/R`を有効にします。
- **VR:** WebXR対応ヘッドセットへ3D動画を表示します。現在は実験的な機能です。
- **Looking Glass:** 再構成した動画を接続中のLooking Glassへ表示します。
  セットアップ、操作、トラブル対処は
  [Looking Glassで使う](#using-looking-glass-ja)を参照してください。

### ビューア設定
- **Projection:** 最も自然な形状になる`pinhole`を推奨します。意図的にデフォルメした
  表示や互換性が必要な場合だけ`relief`を使用します。
- **Framing:** `Auto Source View`が推奨のデフォルトです。動画全体を画面へ収め、
  不適切なカメラ位置による扇形の見え方を避けます。ホイールでカーソル周辺を
  拡大・縮小し、左右どちらかのボタンでドラッグすると移動、ダブルクリックで
  拡大率と位置を戻せます。シーンを回転したい場合は`Free Orbit`を選びます。
- **Min View FOV Y / Source FOV Y:** レンズと画角の高度な設定です。通常の動画では
  自動値・デフォルト値のまま使用してください。
- **Orbit Distance / Model Z Offset:** `Auto Source View`では自動管理されるため、
  スライダーは無効です。カメラとモデルの位置を手動調整する場合は`Free Orbit`を
  選びます。
- **Looking Glass:** 専用操作は
  [Looking Glassの操作](#using-looking-glass-ja)を参照してください。通常はデフォルトの
  自動画角調整と自動奥行き配置を推奨します。
- **Manual target tris:** メッシュ密度の高度な設定です。値を上げると奥行きの細部を
  表現しやすくなりますが、GPU負荷も増えます。
- **クリエイティブ設定:** `Z Scale`、`Z Bias`、`Z Gamma`、`Plane Scale`は、
  `relief`表示を意図的に変形するための設定です。推奨の`pinhole`では不要です。

### 自動パフォーマンスモード
- **Auto Smooth:** 適用済みdepth 30 FPSを目標に、最小のdepth rasterとmesh密度から開始します。
- **Auto Balanced（デフォルト）:** 30 FPSを目標に、中程度のdepth rasterとlog8転送を使います。
- **Auto Quality:** 24 FPSを目標に、設定上限の推論解像度とlinear16から開始し、ネットワークが律速すると空間解像度より先に精度を下げます。
- **Manual / Creative:** 自動変更を停止し、環境変数と手動mesh設定を尊重します。

最初は`Auto Balanced`を推奨します。自動モードは、滑らかな表示を保つために深度の
解像度、転送量、メッシュ密度を調整します。ブラウザで再生する元のRGB動画の画質は
下げません。深度FPSは元動画のFPSを超えません。各項目を自分で調整したい場合だけ
`Manual / Creative`を選んでください。

### 高度な設定
通常は`Auto Balanced`から始め、以下の値は変更しないことを推奨します。手動調整が
必要な場合は、バックエンドの環境変数とフロントエンドのURLパラメータを使用できます。

最適化の仕組みや計測項目の詳しい解説は [`OPTIMIZATION_DETAILS.md`](OPTIMIZATION_DETAILS.md) を参照してください。

**バックエンド環境変数:**

| 変数名 | デフォルト | 説明 |
| :--- | :--- | :--- |
| `VIDEO_DEPTH_INFER_WORKERS` | Windows: `2`; その他: `3` | 同時推論タスク数。GPU/VRAMの余裕を確認できた場合だけ増やしてください。 |
| `VIDEO_DEPTH_DECODER_WORKERS` | `4` | software decoder並列数。各decoderもFFmpeg内部threadを使うため、多core CPUで慎重に増やしてください。 |
| `VIDEO_DEPTH_DOWNSAMPLE` | `1` | 深度マップのダウンサンプル係数。**2 または 4** で帯域削減と FPS 向上。 |
| `VIDEO_DEPTH_PROCESS_RES` | `640` | 推論の最大解像度。値を下げると高速化するがディテール低下。 |
| `VIDEO_DEPTH_SOURCE_FOV_Y` | `50` | カメラ内部パラメータがない動画で使うsource垂直FOV。 |
| `VIDEO_DEPTH_METRIC_REFERENCE_FOCAL_PX` | `300` | DA3Metricの基準焦点距離。異なる規約のモデル以外では変更不要。 |
| `VIDEO_DEPTH_MODEL_ID` | `depth-anything/DA3METRIC-LARGE` | Hugging Face のモデル ID。 |
| `VIDEO_DEPTH_DEVICE` | `auto` | CUDA/ROCm互換、Intel XPU、Apple MPS、CPUの順に自動選択。PyTorch deviceを明示して上書き可能。 |
| `VIDEO_DEPTH_HOST` | `127.0.0.1` | backendのbindアドレス。通常のローカル利用では変更しないでください。 |
| `VIDEO_DEPTH_PORT` | `8000` | backendの待受port。 |
| `VIDEO_DEPTH_CACHE` | `8` | 直近の推論済みdepth結果cache数。 |
| `VIDEO_DEPTH_COMPRESSION` | `0` | Zlib圧縮レベル（0–9）。0は圧縮無効で、localhostの低遅延用途に推奨。 |
| `VIDEO_DEPTH_ENCODING` | `log8` | Manualモードの転送形式。`log8`（半分の転送量）または`linear16`（最大精度）。 |
| `VIDEO_DEPTH_OPTIMIZATION_MODE` | `balanced` | 初期モード。`smooth`、`balanced`、`quality`、`manual`。ストリーミング開始後はフロントエンド選択が優先されます。 |
| `VIDEO_DEPTH_PROFILE_TIMING` | `False` | 詳細なタイミングログを有効化。 |
| `VIDEO_DEPTH_LOG_LEVEL` | `WARNING` | log level（DEBUG、INFO、WARNING、ERROR）。統計表示には`INFO`を使用。 |
| `DA3_LOG_LEVEL` | `WARN` | Depth Anything 3のlog level。frame単位の推論診断が必要な場合だけ`INFO`に設定。 |
| `VIDEO_DEPTH_DATA_ROOT` | `tmp/sessions` | backend source copyのroot。default rootは新session前に削除され、custom rootの自動削除には`VIDEO_DEPTH_CLEAR_CACHE=1`が必要です。 |
| `VIDEO_DEPTH_CLEAR_CACHE` | `False` | `VIDEO_DEPTH_DATA_ROOT` がデフォルト以外でもキャッシュ削除を許可します。 |
| `UV_CACHE_DIR` | – | uv のキャッシュパス（例: `.uv-cache`）。ダウンロード失敗を防止。 |

**フロントエンド URL パラメータ:**
- `?maxInflight=N`: 初期値またはManual時の同時request上限（デフォルト8）。自動modeでは推論worker数から再設定されます。

### コントリビューター向けテストと自動生成動画
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
