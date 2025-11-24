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
  - **Flow control:** Priority queue drops stale frames to prevent latency buildup.
  - **WebSocket stream:** Depth maps are quantized (uint16), optionally downsampled, and sent with a binary header.
- **Frontend (Vite + Three.js/WebXR)**
  - **DepthBuffer:** Manages sync, handles jitter, and re-requests missing frames.
  - **Mesh generation:** Grid mesh displaced in the vertex shader by the depth map.
  - **WebXR:** RawXR path renders the same mesh to both eyes; Three.js XR is disabled (experimental VR).

### Setup & Run
1. **Install dependencies (uv):**
   ```bash
   uv venv .venv
   uv pip install -e ".[dev,inference]"
   uv pip install "depth-anything-3 @ git+https://github.com/ByteDance-Seed/Depth-Anything-3@main"
   ```

2. **One-click Run (Recommended):**
   ```bash
   ./start.sh
   ```
   This starts both the backend (port 8000) and frontend (port 5173).
   
   > [!NOTE]
   > **First Run:** On the very first run, the application will download the Depth Anything 3 model (**approx. 1.3GB**). This may take some time. Please check the console for progress. Once the depth inference starts successfully, it is recommended to **restart the application** once for optimal stability.

   > [!IMPORTANT]
   > **Restarting the App:** If you need to restart the application, please **close the browser tab first** before running the script again. This ensures a clean state for the frontend connection.

3. **Manual Run (Alternative):**
   - **Backend:**
     ```bash
     VIDEO_DEPTH_INFER_WORKERS=4 VIDEO_DEPTH_DOWNSAMPLE=4 UV_CACHE_DIR=.uv-cache DA3_LOG_LEVEL=WARN \
     uv run python3 scripts/run_backend.py
     ```
   - **Frontend:**
     ```bash
     cd webapp
     npm install
     npm run dev
     ```
   Then open `http://localhost:5173`.

### Display Modes
- **Normal (PC 2D/3D):** Three.js draws video + depth mesh on the page.
- **SBS Stereo (0DOF):** Side-by-side split for passive stereo (no head tracking).
- **VR (RawXR):** Starts WebXR and renders the depth mesh to both eyes via the RawXR pipeline (experimental).

### Configuration
You can tune performance via backend environment variables and frontend URL parameters.

For a full breakdown of optimization strategies and telemetry knobs, see [`OPTIMIZATION_DETRAILS.md`](OPTIMIZATION_DETAILS.md).

**Backend Environment Variables:**

| Variable | Default | Description |
| :--- | :--- | :--- |
| `VIDEO_DEPTH_INFER_WORKERS` | `3` | Concurrent inference tasks. Use **4–8** on high-end GPUs. |
| `VIDEO_DEPTH_DOWNSAMPLE` | `1` | Depth downsample factor. Set **2 or 4** to reduce bandwidth and raise FPS. |
| `VIDEO_DEPTH_PROCESS_RES` | `640` | Max inference resolution. Lower (e.g., 384) for speed at cost of detail. |
| `VIDEO_DEPTH_MODEL_ID` | `depth-anything/DA3METRIC-LARGE` | Hugging Face model ID. |
| `VIDEO_DEPTH_CACHE` | `8` | Decoded frame cache size. |
| `VIDEO_DEPTH_COMPRESSION` | `0` | Zlib level (0–9). 0 recommended for low latency. |
| `VIDEO_DEPTH_PROFILE_TIMING` | `False` | Enable detailed timing logs. |
| `VIDEO_DEPTH_LOG_LEVEL` | `WARNING` | Log level (DEBUG, INFO, WARNING, ERROR). Set to **INFO** to see stats. |
| `UV_CACHE_DIR` | – | uv cache path (e.g., `.uv-cache`) to avoid download timeouts. |

**Frontend URL Parameters:**
- `?maxInflight=N`: concurrent requests (default 8). Increase to **16–32** if RTT is low; decrease to **4–8** if RTT is high.
- `?debug=true`: Enable verbose logging (Health stats, Perf metrics) in browser console.

### Optimization Details
See [`OPTIMIZATION_DETRAILS.md`](OPTIMIZATION_DETRAILS.md) for optimization internals and telemetry.

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
  - **フロー制御:** 優先度キューで古いリクエストをドロップし、遅延蓄積を防止。
  - **WebSocket ストリーム:** 深度マップを uint16 量子化し、必要に応じてダウンサンプルしてバイナリヘッダー付きで送信。
- **フロントエンド (Vite + Three.js/WebXR)**
  - **DepthBuffer:** 同期管理と欠落フレーム再要求で滑らかな再生を維持。
  - **メッシュ生成:** グリッドメッシュを深度マップで頂点変位。
  - **WebXR:** RawXR (WebGL2) で両目に同じメッシュを描画。同期ズレや黒画面問題を解消。

### セットアップと実行
1. **依存関係のインストール (uv):**
   ```bash
   uv venv .venv
   uv pip install -e ".[dev,inference]"
   uv pip install "depth-anything-3 @ git+https://github.com/ByteDance-Seed/Depth-Anything-3@main"
   ```
2. **ワンクリック起動（推奨）:**
   ```bash
   ./start.sh
   ```
  このスクリプトは、バックエンド (port 8000) とフロントエンド (port 5173) の両方を起動します。

   > [!NOTE]
   > **初回起動時:** 初回実行時には Depth Anything 3 モデル（**約 1.3GB**）のダウンロードが発生するため、デプス推論の開始まで時間がかかります。進捗はコンソールを確認してください。無事デプス推論が開始されたら、**一旦アプリを終了し、再度立ち上げ直す**と挙動が安定するため推奨します。

   > [!IMPORTANT]
   > **アプリの再起動について:** アプリを終了して再度実行する場合には、**一旦ブラウザを閉じてから**実行してください。フロントエンドの接続状態をリセットして誤動作を防ぐためです。   

3. **バックエンド起動（高負荷向け例）:**
   ```bash
   VIDEO_DEPTH_INFER_WORKERS=4 VIDEO_DEPTH_DOWNSAMPLE=4 UV_CACHE_DIR=.uv-cache DA3_LOG_LEVEL=WARN \
   uv run python3 scripts/run_backend.py
   ```

3. **フロントエンド起動:**
   ```bash
   cd webapp
   npm install
   npm run dev
   ```
   ブラウザで `http://localhost:5173` にアクセス。

### 表示モード
- **通常 (PC 2D/3D):** Three.js が動画と深度メッシュを描画。
- **SBS Stereo (0DOF):** サイドバイサイドのパッシブ立体視（頭トラッキングなし）。
- **VR (RawXR):** WebXR を開始し、最適化されたパイプラインで描画。コントローラーで視点操作（オービット、パン、ズーム）が可能。（実験的段階）

### 設定一覧
環境変数（バックエンド）と URL パラメータ（フロントエンド）でパフォーマンスを調整できます。

最適化の仕組みや計測項目の詳しい解説は [`OPTIMIZATION_DETRAILS.md`](OPTIMIZATION_DETAILS.md) を参照してください。

**バックエンド環境変数:**

| 変数名 | デフォルト | 説明 |
| :--- | :--- | :--- |
| `VIDEO_DEPTH_INFER_WORKERS` | `3` | 同時推論タスク数。高性能 GPU なら **4〜8** 推奨。 |
| `VIDEO_DEPTH_DOWNSAMPLE` | `1` | 深度マップのダウンサンプル係数。**2 または 4** で帯域削減と FPS 向上。 |
| `VIDEO_DEPTH_PROCESS_RES` | `640` | 推論の最大解像度。値を下げると高速化するがディテール低下。 |
| `VIDEO_DEPTH_MODEL_ID` | `depth-anything/DA3METRIC-LARGE` | Hugging Face のモデル ID。 |
| `VIDEO_DEPTH_CACHE` | `8` | デコード済みフレームのキャッシュ数。 |
| `VIDEO_DEPTH_COMPRESSION` | `0` | Zlib 圧縮レベル（0–9）。低遅延のため **0（無効）** を推奨。 |
| `VIDEO_DEPTH_PROFILE_TIMING` | `False` | 詳細なタイミングログを有効化。 |
| `UV_CACHE_DIR` | – | uv のキャッシュパス（例: `.uv-cache`）。ダウンロード失敗を防止。 |

**フロントエンド URL パラメータ:**
- `?maxInflight=N`: 同時リクエスト数の上限（デフォルト 8）。RTT が小さければ **16〜32**、大きければ **4〜8** へ。

### 最適化ドキュメント
最適化の仕組みや計測項目の詳しい解説は [`OPTIMIZATION_DETRAILS.md`](OPTIMIZATION_DETRAILS.md) を参照してください。

### License & Acknowledgements
This project is licensed under the Apache License 2.0. See [LICENSE](LICENSE) for details.

- **Depth Anything 3**: This project utilizes the [Depth Anything 3](https://github.com/ByteDance-Seed/Depth-Anything-3) model for depth estimation. Depth Anything 3 is licensed under the Apache License 2.0.
- **Three.js**: Licensed under the MIT License.
- **FastAPI**: Licensed under the MIT License.
