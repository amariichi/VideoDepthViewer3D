// Minimal raw WebXR test; can also render a supplied three.js scene for debugging.

import * as THREE from 'three';
import { drawThreeStereo } from './xrThreeBridge';
import type {
  CameraCalibration,
  DepthFrame,
  ViewerControls,
  ViewFramingMode,
} from './types';
import {
  getEffectiveGeometryControls,
  getProjectionCalibration,
  getProjectionMix,
} from './render/projection';
import { DepthBuffer } from './utils/depthBuffer';

export type RawXRMode = 'quad' | 'mesh' | 'three';

interface DepthMeshReadiness {
  desiredMode: RawXRMode;
  currentMode: RawXRMode;
  hasMesh: boolean;
  hasDepth: boolean;
  hasVideo: boolean;
}

/**
 * A depth frame can arrive after the XR session has already started. Keep the
 * recovery check independent from the mode flag: an earlier startup may have
 * selected `mesh` before the corresponding GPU resources existed.
 */
export function shouldInitializeDepthMesh({
  desiredMode,
  currentMode,
  hasMesh,
  hasDepth,
  hasVideo,
}: DepthMeshReadiness): boolean {
  return (
    desiredMode === 'mesh' &&
    (currentMode !== 'mesh' || !hasMesh) &&
    hasDepth &&
    hasVideo
  );
}

interface MeshState {
  prog: WebGLProgram;
  vao: WebGLVertexArrayObject;
  indexCount: number;
  indexType: number;
  depthTex: WebGLTexture;
  videoTex: WebGLTexture;
  aspect: number;
  targetTriangles: number;
  uniforms: {
    viewProj: WebGLUniformLocation | null;
    model: WebGLUniformLocation | null;
    aspect: WebGLUniformLocation | null;
    zScale: WebGLUniformLocation | null;
    zBias: WebGLUniformLocation | null;
    zGamma: WebGLUniformLocation | null;
    zMaxClip: WebGLUniformLocation | null;
    planeScale: WebGLUniformLocation | null;
    projectionMix: WebGLUniformLocation | null;
    focalNorm: WebGLUniformLocation | null;
    principalUv: WebGLUniformLocation | null;
  };
}

interface RawXRState {
  session: XRSession;
  gl: WebGL2RenderingContext;
  refSpace: XRReferenceSpace;
  baseLayer: XRWebGLLayer;
  running: boolean;
  frameHandle: number | null;
  prog: WebGLProgram;
  vao: WebGLVertexArrayObject;
  cubeProg: WebGLProgram;
  cubeVao: WebGLVertexArrayObject;
  cubeIndexCount: number;
  hintProg: WebGLProgram;
  hintVao: WebGLVertexArrayObject;
  hintTex: WebGLTexture;
  hintNeedsUpload: boolean;
  mesh?: MeshState;
  mode: RawXRMode;
  threeScene?: THREE.Scene;
  leftCam?: THREE.PerspectiveCamera;
  rightCam?: THREE.PerspectiveCamera;
  renderer?: THREE.WebGLRenderer;
  orbitYaw: number;
  orbitPitch: number;
  orbitRadius: number;
  orbitTarget: THREE.Vector3;
  input: {
    left: ControllerState;
    right: ControllerState;
  };
}

type ControllerHand = 'left' | 'right' | 'unknown';

interface ControllerState {
  hand: ControllerHand;
  select: boolean;
  squeeze: boolean;
  axes: [number, number];
  ts: number;
  pos: THREE.Vector3 | null;
}

function makeControllerState(hand: ControllerHand): ControllerState {
  return { hand, select: false, squeeze: false, axes: [0, 0], ts: 0, pos: null };
}

export class RawXRTest {
  private state: RawXRState | null = null;
  private pendingSession: XRSession | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private parent: HTMLElement;
  private threeScene: THREE.Scene | null = null;
  private leftCam: THREE.PerspectiveCamera | null = null;
  private rightCam: THREE.PerspectiveCamera | null = null;
  private desiredMode: RawXRMode = 'mesh';
  private contextLostHandler: ((ev: Event) => void) | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private controlsGetter: (() => ViewerControls) | null = null;
  private calibration: CameraCalibration | null = null;
  private depthBuffer: DepthBuffer | null = null;
  private lastRenderedDepthFrame: DepthFrame | null = null;
  private meshModel: THREE.Matrix4 = new THREE.Matrix4();
  private orbitYaw = 0;
  private orbitPitch = 0;
  private orbitRadius = 2.0;
  private orbitTarget = new THREE.Vector3(0, 0.6, -1.2);
  private xrFramingMode: ViewFramingMode | null = null;
  private sourceViewBaseOrientation = new THREE.Quaternion();
  private input = {
    left: makeControllerState('left'),
    right: makeControllerState('right'),
  };
  private debugEl: HTMLDivElement | null = null;
  private placeholderDepth: DepthFrame | null = null;
  private lastUploadedDepthTimestamp = -1;
  private lastUploadedVideoFrame = -1;
  private hintCanvas: HTMLCanvasElement;
  private hintCtx: CanvasRenderingContext2D | null;
  private hintTimeout: number | null = null;
  // placeholders reserved for future three.js overlay (unused currently)

  constructor(parent: HTMLElement) {
    this.parent = parent;
    this.hintCanvas = document.createElement('canvas');
    this.hintCanvas.width = 1024;
    this.hintCanvas.height = 512;
    this.hintCtx = this.hintCanvas.getContext('2d');
    // billboard quad (Three mesh) at origin; we'll render into hintTexture each frame
    // (three.js overlay reserved; not attached in RawGL path)

    this.debugEl = document.createElement('div');
    this.debugEl.style.position = 'absolute';
    this.debugEl.style.bottom = '8px';
    this.debugEl.style.left = '8px';
    this.debugEl.style.padding = '6px 8px';
    this.debugEl.style.background = 'rgba(0,0,0,0.6)';
    this.debugEl.style.color = '#0f0';
    this.debugEl.style.fontSize = '12px';
    this.debugEl.style.zIndex = '9999';
    this.debugEl.style.pointerEvents = 'none';
    this.debugEl.style.whiteSpace = 'pre';
    this.debugEl.style.fontFamily = 'monospace';
    this.parent.appendChild(this.debugEl);
  }

  /**
   * Request XR session with minimal options.
   * Avoids fallback loops entirely to prevent SecurityError (loss of user activation).
   */
  private async requestSessionWithFallback(): Promise<XRSession> {
    // Request multiple optional features to maximize compatibility.
    // Including 'viewer' and 'local' ensures we get a session even if 'local-floor' is unavailable.
    const init: XRSessionInit = {
      optionalFeatures: ['local-floor', 'local', 'viewer'],
    };
    return await navigator.xr!.requestSession('immersive-vr', init);
  }

  // Intentionally keep RawXR on its own WebGL2 context to avoid state conflicts with three.js renderer.

  setVideo(video: HTMLVideoElement): void {
    this.videoEl = video;
  }

  setControlsGetter(fn: () => ViewerControls): void {
    this.controlsGetter = fn;
  }

  setCalibration(calibration: CameraCalibration | null): void {
    this.calibration = calibration;
  }

  private onSessionEnded: (() => void) | null = null;

  setSessionEndedCallback(cb: () => void): void {
    this.onSessionEnded = cb;
  }

  setDepthBuffer(buffer: DepthBuffer): void {
    this.depthBuffer = buffer;
    this.lastRenderedDepthFrame = null;
    this.lastUploadedDepthTimestamp = -1;
    this.lastUploadedVideoFrame = -1;
  }

  enableDepthMesh(): void {
    this.desiredMode = 'mesh';
  }

  async start(): Promise<void> {
    if (this.state) {
      return;
    }
    if (!('xr' in navigator)) {
      throw new Error('WebXR unavailable in this browser');
    }
    const supported = await navigator.xr!.isSessionSupported('immersive-vr');
    if (!supported) {
      throw new Error('immersive-vr not supported');
    }

    this.xrFramingMode = null;
    this.sourceViewBaseOrientation.identity();
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.orbitRadius = 2.0;
    this.orbitTarget.set(0, 0.6, -1.2);

    this.canvas = document.createElement('canvas');
    this.canvas.style.position = 'absolute';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.parent.appendChild(this.canvas);
    // Ensure debug overlay is on top of the new canvas
    if (this.debugEl) {
      this.parent.appendChild(this.debugEl);
    }

    const gl = this.canvas.getContext('webgl2', { xrCompatible: true, antialias: true, alpha: false });
    if (!gl) {
      throw new Error('WebGL2 context unavailable');
    }

    const session = await this.requestSessionWithFallback();
    this.pendingSession = session;

    type XRCompatibleWebGL2 = WebGL2RenderingContext & {
      makeXRCompatible?: () => Promise<void>;
    };

    const glXR = gl as XRCompatibleWebGL2;

    if (typeof glXR.makeXRCompatible === "function") {
      await glXR.makeXRCompatible();
    }

    const baseLayer = new XRWebGLLayer(session, gl, { antialias: true, alpha: false });
    session.updateRenderState({ baseLayer });

    // If the GL context is lost mid-session, end XR cleanly to avoid a stuck canvas.
    if (this.canvas) {
      this.contextLostHandler = (ev: Event) => {
        ev.preventDefault();
        console.warn('XR GL context lost; ending session');
        session.end().catch(() => undefined);
      };
      this.canvas.addEventListener('webglcontextlost', this.contextLostHandler, { once: true });
    }

    let refSpace: XRReferenceSpace;
    try {
      refSpace = await session.requestReferenceSpace('local-floor');
    } catch {
      try {
        refSpace = await session.requestReferenceSpace('local');
      } catch {
        console.warn('local/local-floor not supported, falling back to viewer');
        refSpace = await session.requestReferenceSpace('viewer');
      }
    }

    // Build program/VAO once
    const quad = new Float32Array([
      -0.2, -0.2,
      0.2, -0.2,
      -0.2, 0.2,
      0.2, 0.2,
    ]);
    const vs = `#version 300 es
      in vec2 aPos;
      void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
    `;
    const fs = `#version 300 es
      precision highp float;
      out vec4 fragColor;
      void main() { fragColor = vec4(1.0, 1.0, 0.0, 1.0); }
    `;
    const prog = this.makeProgram(gl as WebGL2RenderingContext, vs, fs);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    // Cube program/geometry (for stereo parallax確認)
    const cubeVs = `#version 300 es
      layout(location=0) in vec3 aPos;
      layout(location=1) in vec3 aColor;
      uniform mat4 uViewProj;
      out vec3 vColor;
      void main(){
        vColor = aColor;
        gl_Position = uViewProj * vec4(aPos, 1.0);
      }
    `;
    const cubeFs = `#version 300 es
      precision highp float;
      in vec3 vColor;
      out vec4 fragColor;
      void main(){ fragColor = vec4(vColor, 1.0); }
    `;
    const cubeProg = this.makeProgram(gl as WebGL2RenderingContext, cubeVs, cubeFs);
    const cubeVao = gl.createVertexArray()!;
    gl.bindVertexArray(cubeVao);
    const cubeBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, cubeBuf);
    // simple cube at z=-1 size 0.6
    const s = 0.3;
    const z = -1.0;
    const cubeVerts = new Float32Array([
      // pos               // color
      -s, -s, z, 1, 0, 0,
      s, -s, z, 0, 1, 0,
      s, s, z, 0, 0, 1,
      -s, s, z, 1, 1, 0,
      -s, -s, z - 0.6, 1, 0, 1,
      s, -s, z - 0.6, 0, 1, 1,
      s, s, z - 0.6, 1, 1, 1,
      -s, s, z - 0.6, 0.2, 0.8, 0.2,
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, cubeVerts, gl.STATIC_DRAW);
    const stride = 6 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 3 * 4);
    const idx = new Uint16Array([
      0, 1, 2, 0, 2, 3, // front
      4, 5, 6, 4, 6, 7, // back
      0, 1, 5, 0, 5, 4, // bottom
      2, 3, 7, 2, 7, 6, // top
      1, 2, 6, 1, 6, 5, // right
      0, 3, 7, 0, 7, 4  // left
    ]);
    const ib = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

    // Hint overlay quad (NDC space small rect)
    const hintVs = `#version 300 es
      layout(location=0) in vec2 aPos;
      layout(location=1) in vec2 aUv;
      uniform vec2 uOffset;
      out vec2 vUv;
      void main(){
        vUv = aUv;
        vec2 pos = aPos + uOffset;
        gl_Position = vec4(pos, 0.0, 1.0);
      }
    `;
    const hintFs = `#version 300 es
      precision highp float;
      in vec2 vUv;
      uniform sampler2D uTex;
      out vec4 fragColor;
      void main(){ fragColor = texture(uTex, vUv); }
    `;
    const hintProg = this.makeProgram(gl as WebGL2RenderingContext, hintVs, hintFs);
    const hintVao = gl.createVertexArray()!;
    gl.bindVertexArray(hintVao);
    const hintBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, hintBuf);
    // centered quad, small to reduce stereo separation
    const hVerts = new Float32Array([
      -0.18, -0.10, 0, 0,
      0.18, -0.10, 1, 0,
      -0.18, 0.10, 0, 1,
      0.18, 0.10, 1, 1,
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, hVerts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 4 * 4, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 4 * 4, 2 * 4);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    const hintTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, hintTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);


    // Decide rendering mode: prefer depth mesh only after its GPU resources
    // exist. The frame loop upgrades from the fallback as soon as depth arrives.
    const canMesh = this.depthBuffer && this.videoEl && this.desiredMode === 'mesh';

    // Initial mesh setup if possible (though loop will handle it)
    let meshState: MeshState | undefined;
    if (canMesh && this.depthBuffer && this.videoEl) {
      const timeMs = this.videoEl.currentTime * 1000;
      const frame = this.depthBuffer.getFrame(timeMs);
      if (frame) {
        meshState = this.ensureMeshResources(gl as WebGL2RenderingContext, frame, this.getControls());
      }
    }
    const mode: RawXRMode = meshState
      ? 'mesh'
      : (this.threeScene && this.desiredMode === 'three' ? 'three' : 'quad');

    this.state = {
      session,
      gl: gl as WebGL2RenderingContext,
      refSpace,
      baseLayer,
      running: true,
      frameHandle: null,
      prog,
      vao,
      cubeProg,
      cubeVao,
      cubeIndexCount: idx.length,
      hintProg,
      hintVao,
      hintTex,
      hintNeedsUpload: true,
      mesh: meshState,
      mode,
      threeScene: this.threeScene ?? undefined,
      leftCam: this.leftCam ?? undefined,
      rightCam: this.rightCam ?? undefined,
      renderer: undefined,
      orbitYaw: this.orbitYaw,
      orbitPitch: this.orbitPitch,
      orbitRadius: this.orbitRadius,
      orbitTarget: this.orbitTarget.clone(),
      input: this.input,
    };
    this.pendingSession = null;

    session.addEventListener('end', () => this.stop());
    session.addEventListener('inputsourceschange', (e) => this.handleInputSourcesChange(e));
    session.addEventListener('selectstart', (e) => this.handleSelect(e, true));
    session.addEventListener('selectend', (e) => this.handleSelect(e, false));
    session.addEventListener('squeezestart', (e) => this.handleSqueeze(e, true));
    session.addEventListener('squeezeend', (e) => this.handleSqueeze(e, false));
    // 初期入力ソースをログ
    this.logSources(Array.from(session.inputSources));
    // Intro controls overlay (3s)
    this.showHint('Controls', 3000, 'Trigger + Move: Orbit\nGrip + Move: Pan/Move\nStick LR: Zoom');
    // Ensure media continues in XR (some browsers pause on session start)
    this.videoEl?.play().catch(() => undefined);
    this.loop();
  }

  private handleInputSourcesChange(event: XRInputSourcesChangeEvent): void {
    // reset states for removed sources
    const removed = event.removed || [];
    for (const src of removed) {
      const hand = src.handedness as ControllerHand;
      const state = hand === 'left' ? this.input.left : hand === 'right' ? this.input.right : null;
      if (state) {
        state.select = false;
        state.squeeze = false;
        state.axes = [0, 0];
      }
    }

    const added = event.added || [];
    if (added.length || removed.length) {
      this.logSources(added, removed);
    }
  }

  private handleSelect(event: XRInputSourceEvent, pressed: boolean): void {
    const hand = event.inputSource.handedness as ControllerHand;
    const state = hand === 'left' ? this.input.left : hand === 'right' ? this.input.right : null;
    if (state) state.select = pressed;
    this.logInput(`select ${hand} ${pressed}`);
  }

  private handleSqueeze(event: XRInputSourceEvent, pressed: boolean): void {
    const hand = event.inputSource.handedness as ControllerHand;
    const state = hand === 'left' ? this.input.left : hand === 'right' ? this.input.right : null;
    if (state) state.squeeze = pressed;
    this.logInput(`squeeze ${hand} ${pressed}`);
  }

  private hintsEnabled = true;

  setHintsEnabled(enabled: boolean): void {
    this.hintsEnabled = enabled;
    if (!enabled && this.hintCtx) {
      // Clear existing hint immediately
      this.hintCtx.clearRect(0, 0, this.hintCanvas.width, this.hintCanvas.height);
      if (this.state) this.state.hintNeedsUpload = true;
    }
  }

  async stop(): Promise<void> {
    const state = this.state;
    const session = state?.session ?? this.pendingSession;
    const canvas = this.canvas;
    const contextLostHandler = this.contextLostHandler;
    const hadResources = Boolean(state || session || canvas);

    // Clear shared references before ending the session. The session's `end`
    // event calls stop() again, and this makes that re-entry a no-op.
    this.state = null;
    this.pendingSession = null;
    this.canvas = null;
    this.contextLostHandler = null;

    if (!hadResources) return;
    if (state) {
      state.running = false;
      if (state.frameHandle !== null) {
        state.session.cancelAnimationFrame(state.frameHandle);
      }
    }
    if (session) {
      try {
        await session.end();
      } catch {
        /* ignore */
      }
    }
    if (canvas && contextLostHandler) {
      canvas.removeEventListener('webglcontextlost', contextLostHandler);
    }
    if (canvas?.parentElement) {
      canvas.parentElement.removeChild(canvas);
    }
    // Keep debugEl alive as requested
    if (this.onSessionEnded) this.onSessionEnded();
  }

  private loop(): void {
    if (!this.state) return;
    const { session } = this.state;
    this.state.frameHandle = session.requestAnimationFrame((time, frame) => this.onXRFrame(time, frame));
  }

  private onXRFrame(_time: DOMHighResTimeStamp, frame: XRFrame): void {
    const s = this.state;
    if (!s || !s.running) return;
    const pose = frame.getViewerPose(s.refSpace);
    if (!pose) {
      this.loop();
      return;
    }
    const gl = s.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.baseLayer.framebuffer);
    gl.enable(gl.SCISSOR_TEST);

    this.syncViewerSourceAnchor(pose, this.getControls().framingMode);
    this.updateFromControllers(s.session, frame, s.refSpace);

    // Pull latest depth frame from buffer
    let currentDepth: DepthFrame | null = null;
    if (this.depthBuffer && this.videoEl) {
      const timeMs = this.videoEl.currentTime * 1000;
      currentDepth = this.depthBuffer.getFrame(timeMs);
    }

    // Persistence logic: if we missed a frame (sync miss), use the last known good one.
    // This prevents flickering/black screen during minor jitters.
    if (currentDepth) {
      this.lastRenderedDepthFrame = currentDepth;
    } else if (this.lastRenderedDepthFrame) {
      currentDepth = this.lastRenderedDepthFrame;
    }

    // If depth/video became available after session start, switch into mesh mode on the fly.
    if (shouldInitializeDepthMesh({
      desiredMode: this.desiredMode,
      currentMode: s.mode,
      hasMesh: Boolean(s.mesh),
      hasDepth: Boolean(currentDepth),
      hasVideo: Boolean(this.videoEl),
    }) && currentDepth && this.videoEl) {
      s.mode = 'mesh';
      s.mesh = this.ensureMeshResources(gl, currentDepth, this.getControls(), s.mesh);
    }

    if (s.mode === 'mesh' && s.mesh && this.videoEl) {
      const controls = this.getControls();
      const depth = currentDepth ?? this.getPlaceholderDepth();
      const projection = getProjectionCalibration(
        this.calibration,
        controls,
        depth.width / depth.height
      );
      const effective = getEffectiveGeometryControls(
        controls,
        projection.depthMetricScale
      );

      // Rebuild mesh if aspect/triangle target changed mid-session
      s.mesh = this.ensureMeshResources(gl, depth, controls, s.mesh);
      if (depth.timestampMs !== this.lastUploadedDepthTimestamp) {
        this.uploadDepthTexture(gl, s.mesh.depthTex, depth);
        this.lastUploadedDepthTimestamp = depth.timestampMs;
      }
      const videoFrame =
        this.videoEl.getVideoPlaybackQuality?.().totalVideoFrames ??
        Math.floor(this.videoEl.currentTime * 1000);
      if (videoFrame !== this.lastUploadedVideoFrame) {
        this.uploadVideoTexture(gl, s.mesh.videoTex, this.videoEl);
        this.lastUploadedVideoFrame = videoFrame;
      }
      // model matrix is maintained in updateFromControllers (orbit/pan/zoom)
      const model = this.meshModel.clone();

      for (const view of pose.views) {
        const viewport = s.baseLayer.getViewport(view);
        if (!viewport) continue;
        gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
        gl.scissor(viewport.x, viewport.y, viewport.width, viewport.height);
        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.CULL_FACE);
        gl.clearColor(0.05, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        const viewMat = new THREE.Matrix4().fromArray(view.transform.matrix as unknown as number[]);
        const camMat = viewMat.invert();
        const proj = new THREE.Matrix4().fromArray(view.projectionMatrix as unknown as number[]);
        const viewProj = new THREE.Matrix4().multiplyMatrices(proj, camMat);

        gl.useProgram(s.mesh.prog);
        gl.uniformMatrix4fv(s.mesh.uniforms.viewProj, false, viewProj.elements as unknown as Float32List);
        gl.uniformMatrix4fv(s.mesh.uniforms.model, false, model.elements as unknown as Float32List);
        gl.uniform1f(s.mesh.uniforms.aspect, projection.displayAspect);
        gl.uniform1f(s.mesh.uniforms.zScale, effective.zScale);
        gl.uniform1f(s.mesh.uniforms.zBias, effective.zBias);
        gl.uniform1f(s.mesh.uniforms.zGamma, effective.zGamma);
        gl.uniform1f(s.mesh.uniforms.zMaxClip, controls.zMaxClip);
        gl.uniform1f(s.mesh.uniforms.planeScale, effective.planeScale);
        gl.uniform1f(s.mesh.uniforms.projectionMix, getProjectionMix(controls));
        gl.uniform2f(
          s.mesh.uniforms.focalNorm,
          projection.focalNormX,
          projection.focalNormY
        );
        gl.uniform2f(
          s.mesh.uniforms.principalUv,
          projection.principalUvX,
          projection.principalUvY
        );

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, s.mesh.depthTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, s.mesh.videoTex);

        gl.bindVertexArray(s.mesh.vao);
        gl.drawElements(gl.TRIANGLES, s.mesh.indexCount, s.mesh.indexType, 0);
        this.drawHint(gl, s, view);
      }
    } else if (s.mode === 'three' && s.renderer && s.threeScene && s.leftCam && s.rightCam) {
      drawThreeStereo(gl, s.baseLayer, pose, s.refSpace, {
        scene: s.threeScene,
        leftCam: s.leftCam,
        rightCam: s.rightCam,
        renderer: s.renderer,
      });
    } else {
      this.drawDebug(gl, s, pose);
    }

    this.loop();
  }

  private makeProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
    const v = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(v, vs);
    gl.compileShader(v);
    if (!gl.getShaderParameter(v, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(v) || 'VS compile failed');
    }
    const f = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(f, fs);
    gl.compileShader(f);
    if (!gl.getShaderParameter(f, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(f) || 'FS compile failed');
    }
    const p = gl.createProgram()!;
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p) || 'Program link failed');
    }
    gl.deleteShader(v);
    gl.deleteShader(f);
    return p;
  }

  private drawDebug(gl: WebGL2RenderingContext, s: RawXRState, pose: XRViewerPose): void {
    for (const view of pose.views) {
      const viewport = s.baseLayer.getViewport(view);
      if (!viewport) continue;
      gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
      gl.scissor(viewport.x, viewport.y, viewport.width, viewport.height);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.clearColor(0.0, 0.0, 0.0, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      // Keep hint available (e.g., if no mesh yet)
      this.drawHint(gl, s, view);
    }
  }

  private drawHint(gl: WebGL2RenderingContext, s: RawXRState, view?: XRView): void {
    // Render billboard in view space so it always appears centered
    if (!s.hintVao || !s.hintProg || !s.hintTex) return;
    if (s.hintNeedsUpload && this.hintCtx) {
      gl.bindTexture(gl.TEXTURE_2D, s.hintTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.hintCanvas);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0); // Restore default
      s.hintNeedsUpload = false;
    }
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(s.hintProg);
    // Slight eye-dependent offset to converge images
    let offset = 0;
    if (view && (view as XRView & { eye?: string }).eye) {
      const eye = (view as XRView & { eye?: string }).eye;
      offset = eye === 'left' ? 0.125 : eye === 'right' ? -0.125 : 0;
    }
    const offsetLoc = gl.getUniformLocation(s.hintProg, 'uOffset');
    const loc = gl.getUniformLocation(s.hintProg, 'uTex');
    if (offsetLoc) gl.uniform2f(offsetLoc, offset, 0);
    if (loc) gl.uniform1i(loc, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, s.hintTex);
    gl.bindVertexArray(s.hintVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  private getControls(): ViewerControls {
    const fallback: ViewerControls = {
      projectionMode: 'pinhole',
      framingMode: 'source',
      targetTriangles: 8000,
      fovY: 60,
      sourceFovY: 60,
      zScale: 1.0,
      zBias: 0.0,
      zGamma: 1.0,
      zMaxClip: 5.0,
      planeScale: 1.0,
      yOffset: 0.0,
    };
    return this.controlsGetter ? this.controlsGetter() : fallback;
  }

  private ensureMeshResources(
    gl: WebGL2RenderingContext,
    depth: DepthFrame,
    controls: ViewerControls,
    existing?: MeshState
  ): MeshState {
    const aspect = getProjectionCalibration(
      this.calibration,
      controls,
      depth.width / depth.height
    ).displayAspect;
    const targetTris = controls.targetTriangles;

    // Create program once
    let prog = existing?.prog;
    let uniforms = existing?.uniforms;
    if (!prog || !uniforms) {
      const vs = `#version 300 es\n
        layout(location=0) in vec2 aUv;\n
        uniform mat4 uViewProj;\n
        uniform mat4 uModel;\n
        uniform sampler2D uDepthTex;\n
        uniform float uAspect;\n
        uniform float uZScale;\n
        uniform float uZBias;\n
        uniform float uZGamma;\n
        uniform float uZMaxClip;\n
        uniform float uPlaneScale;\n
        uniform float uProjectionMix;\n
        uniform vec2 uFocalNorm;\n
        uniform vec2 uPrincipalUv;\n
        out vec2 vUv;\n
        void main(){\n
          // Keep video座標は左→右、上→下。サンプルは上下反転のみ。
          vUv = vec2(aUv.x, 1.0 - aUv.y);
          float depth = texture(uDepthTex, vUv).r;\n
          depth = pow(max(depth, 0.0), uZGamma);\n
          // Clip only the depth-derived component. Bias is a global offset and
          // should not be clamped, otherwise it saturates Z to a constant and
          // the mesh looks flat.
          float zDepth = clamp(depth * uZScale, 0.0, uZMaxClip);\n
          float z = zDepth + uZBias;
          float reliefX = (aUv.x - 0.5) * uAspect * uPlaneScale;\n
          float reliefY = (0.5 - aUv.y) * uPlaneScale;\n
          float pinholeX = ((vUv.x - uPrincipalUv.x) / uFocalNorm.x) * z;\n
          float pinholeY = ((vUv.y - uPrincipalUv.y) / uFocalNorm.y) * z;\n
          float x = mix(reliefX, pinholeX, uProjectionMix);\n
          float y = mix(reliefY, pinholeY, uProjectionMix);\n
          vec4 local = vec4(x, y, -z, 1.0);\n
          gl_Position = uViewProj * uModel * local;\n
        }`;
      const fs = `#version 300 es\n
        precision highp float;\n
        in vec2 vUv;\n
        uniform sampler2D uVideoTex;\n
        out vec4 fragColor;\n
        void main(){\n
          fragColor = texture(uVideoTex, vUv);\n
        }`;
      prog = this.makeProgram(gl, vs, fs);
      uniforms = {
        viewProj: gl.getUniformLocation(prog, 'uViewProj'),
        model: gl.getUniformLocation(prog, 'uModel'),
        aspect: gl.getUniformLocation(prog, 'uAspect'),
        zScale: gl.getUniformLocation(prog, 'uZScale'),
        zBias: gl.getUniformLocation(prog, 'uZBias'),
        zGamma: gl.getUniformLocation(prog, 'uZGamma'),
        zMaxClip: gl.getUniformLocation(prog, 'uZMaxClip'),
        planeScale: gl.getUniformLocation(prog, 'uPlaneScale'),
        projectionMix: gl.getUniformLocation(prog, 'uProjectionMix'),
        focalNorm: gl.getUniformLocation(prog, 'uFocalNorm'),
        principalUv: gl.getUniformLocation(prog, 'uPrincipalUv'),
      };
      gl.useProgram(prog);
      const depthLoc = gl.getUniformLocation(prog, 'uDepthTex');
      const videoLoc = gl.getUniformLocation(prog, 'uVideoTex');
      if (depthLoc) gl.uniform1i(depthLoc, 0);
      if (videoLoc) gl.uniform1i(videoLoc, 1);
    }

    const needsGridRebuild = !existing || Math.abs(existing.aspect - aspect) > 0.001 || existing.targetTriangles !== targetTris;

    let vao = existing?.vao ?? null;
    let indexCount = existing?.indexCount ?? 0;
    let indexType = existing?.indexType ?? gl.UNSIGNED_SHORT;
    if (needsGridRebuild) {
      if (vao) {
        gl.deleteVertexArray(vao);
      }
      const grid = this.buildGrid(gl, aspect, targetTris);
      vao = grid.vao;
      indexCount = grid.indexCount;
      indexType = grid.indexType;
    }

    const depthTex = existing?.depthTex ?? gl.createTexture()!;
    const videoTex = existing?.videoTex ?? gl.createTexture()!;

    // Set static params once
    gl.bindTexture(gl.TEXTURE_2D, depthTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindTexture(gl.TEXTURE_2D, videoTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    return {
      prog,
      vao: vao!,
      indexCount,
      indexType,
      depthTex,
      videoTex,
      aspect,
      targetTriangles: targetTris,
      uniforms,
    };
  }

  private buildGrid(gl: WebGL2RenderingContext, aspect: number, targetTriangles: number): { vao: WebGLVertexArrayObject; indexCount: number; indexType: number } {
    const epsilon = Math.max(targetTriangles, 10);
    const nxFloat = Math.sqrt((epsilon * Math.max(aspect, 0.1)) / 2);
    const nyFloat = Math.sqrt(epsilon / (2 * Math.max(aspect, 0.1)));
    const segmentsX = Math.max(2, Math.round(nxFloat));
    let segmentsY = Math.max(2, Math.round(nyFloat));
    if (aspect < 1 && segmentsY > 1024) {
      const stride = Math.ceil(segmentsY / 1024);
      segmentsY = Math.max(2, Math.floor(segmentsY / stride));
    }

    const verts: number[] = [];
    for (let y = 0; y <= segmentsY; y++) {
      for (let x = 0; x <= segmentsX; x++) {
        const u = x / segmentsX;
        const v = y / segmentsY;
        verts.push(u, v);
      }
    }

    const indices: number[] = [];
    const stride = segmentsX + 1;
    for (let y = 0; y < segmentsY; y++) {
      for (let x = 0; x < segmentsX; x++) {
        const i0 = y * stride + x;
        const i1 = i0 + 1;
        const i2 = i0 + stride;
        const i3 = i2 + 1;
        indices.push(i0, i2, i1, i1, i2, i3);
      }
    }

    const useUint32 = (segmentsX + 1) * (segmentsY + 1) > 65535;
    const idxArray = useUint32 ? new Uint32Array(indices) : new Uint16Array(indices);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 2 * 4, 0);
    const ebo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idxArray, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

    return { vao, indexCount: indices.length, indexType: useUint32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
  }

  private uploadDepthTexture(gl: WebGL2RenderingContext, tex: WebGLTexture, frame: DepthFrame): void {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // Ensure depth is flipped to match video (Video uses FLIP_Y=1)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, frame.width, frame.height, 0, gl.RED, gl.FLOAT, frame.data);
  }

  private uploadVideoTexture(gl: WebGL2RenderingContext, tex: WebGLTexture, video: HTMLVideoElement): void {
    if (!video.videoWidth || !video.videoHeight) return;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
  }

  private getPlaceholderDepth(): DepthFrame {
    if (this.placeholderDepth) return this.placeholderDepth;
    const w = this.calibration?.inferenceWidth || this.videoEl?.videoWidth || 1920;
    const h = this.calibration?.inferenceHeight || this.videoEl?.videoHeight || 1080;
    const data = new Float32Array(w * h); // zeros => flat plane
    this.placeholderDepth = {
      timestampMs: 0,
      width: w,
      height: h,
      data,
      scale: 1,
      bias: 0,
      zMax: 1,
    };
    return this.placeholderDepth;
  }

  /**
   * Anchor the reconstructed source-camera origin at the midpoint of the first
   * valid XR viewer pose. The anchor stays fixed afterwards, so later head or
   * Looking Glass view motion produces real parallax instead of head-locking
   * the video surface.
   */
  private syncViewerSourceAnchor(
    pose: XRViewerPose,
    framingMode: ViewFramingMode
  ): void {
    if (this.xrFramingMode === framingMode) return;
    this.xrFramingMode = framingMode;

    if (framingMode !== 'source' || pose.views.length === 0) {
      this.sourceViewBaseOrientation.identity();
      return;
    }

    const center = new THREE.Vector3();
    const orientation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const viewPosition = new THREE.Vector3();
    const viewOrientation = new THREE.Quaternion();

    pose.views.forEach((view, index) => {
      new THREE.Matrix4()
        .fromArray(view.transform.matrix as unknown as number[])
        .decompose(viewPosition, viewOrientation, scale);
      center.add(viewPosition);
      if (index === 0) {
        orientation.copy(viewOrientation);
      } else {
        if (orientation.dot(viewOrientation) < 0) {
          viewOrientation.set(
            -viewOrientation.x,
            -viewOrientation.y,
            -viewOrientation.z,
            -viewOrientation.w
          );
        }
        orientation.slerp(viewOrientation, 1 / (index + 1));
      }
    });

    center.multiplyScalar(1 / pose.views.length);
    this.orbitTarget.copy(center);
    this.sourceViewBaseOrientation.copy(orientation).normalize();
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.orbitRadius = 2.0;
    this.meshModel.compose(
      center,
      this.sourceViewBaseOrientation,
      new THREE.Vector3(1, 1, 1)
    );
  }

  private updateFromControllers(session: XRSession, frame: XRFrame, refSpace: XRReferenceSpace): void {
    const sources = session.inputSources;
    const deadzone = 0.08;
    const yawSpeed = 0.03;
    const pitchSpeed = 0.03;
    const panSpeed = 0.06;
    const zoomSpeed = 0.06;
    const poseRotScale = 2000; // meters -> virtual rotation pixels (ref app style)
    const posePanScale = 1500; // meters -> pan pixels
    const posePanZScale = 5;   // meters -> forward/back pan

    const now = performance.now();
    let anyGamepad = false;

    // refresh axes state (use dominant stick like reference app)
    const pickStick = (axes: readonly number[]): [number, number] => {
      if (!axes || axes.length === 0) return [0, 0];
      const pairs: Array<[number, number]> = [];
      if (axes.length >= 2) pairs.push([axes[0], axes[1]]);
      if (axes.length >= 4) pairs.push([axes[2], axes[3]]);
      if (!pairs.length) return [0, 0];
      let best = pairs[0];
      let bestMag = Math.abs(best[0]) + Math.abs(best[1]);
      for (let i = 1; i < pairs.length; i++) {
        const cand = pairs[i];
        const mag = Math.abs(cand[0]) + Math.abs(cand[1]);
        if (mag > bestMag) {
          best = cand;
          bestMag = mag;
        }
      }
      return best;
    };

    for (const source of sources) {
      const hand: ControllerHand = (source.handedness as ControllerHand) || 'unknown';
      const gp = source.gamepad;
      if (!gp || !gp.axes || gp.axes.length === 0) continue;
      anyGamepad = true;
      const state = hand === 'left' ? this.input.left : hand === 'right' ? this.input.right : null;
      if (!state) continue;
      const [sx, sy] = pickStick(gp.axes);
      const axX = Math.abs(sx) > deadzone ? sx : 0;
      const axY = Math.abs(sy) > deadzone ? sy : 0;
      state.axes = [axX, axY];
      state.ts = now;
      state.select = gp.buttons?.[0]?.pressed ?? state.select;
      state.squeeze = gp.buttons?.[1]?.pressed ?? state.squeeze;
    }

    if (!anyGamepad) {
      // fallback: try navigator.getGamepads (LinkでinputSourcesが空になる場合がある)
      const gps =
        "getGamepads" in navigator && typeof navigator.getGamepads === "function"
          ? navigator.getGamepads()
          : [];

      const gp =
        gps && gps.length
          ? gps.find((g): g is Gamepad => !!g && g.axes.length >= 2)
          : null;
    
      if (gp) {
        anyGamepad = true;
    
        const [sx, sy] = pickStick(gp.axes);
        const axX = Math.abs(sx) > deadzone ? sx : 0;
        const axY = Math.abs(sy) > deadzone ? sy : 0;
    
        const state = this.input.right;
        state.axes = [axX, axY];
        state.select = gp.buttons[0]?.pressed ?? false;
        state.squeeze = gp.buttons[1]?.pressed ?? false;
        state.ts = now;

        this.logInput("[XR] using navigator.getGamepads fallback");
      } else {
        this.logInput("[XR] no gamepad axes (sources=" + sources.length + ", gp=0)");
      }
    }

    const primary = this.input.right.ts >= this.input.left.ts ? this.input.right : this.input.left;
    const axX = primary.axes[0];
    const axY = primary.axes[1];
    const trigger = primary.select;
    const grip = primary.squeeze;

    // Try pose-based deltas first (more reliable on Quest Link)
    const sourcesArr = Array.from(sources);
    const source = primary.hand === 'left'
      ? sourcesArr.find((s) => s.handedness === 'left')
      : sourcesArr.find((s) => s.handedness === 'right') || sourcesArr[0];
    if (source) {
      const space = source.gripSpace || source.targetRaySpace;
      if (space) {
        const pose = frame.getPose(space, refSpace);
        if (pose && pose.transform.position) {
          const p = pose.transform.position;
          const curr = new THREE.Vector3(p.x, p.y, p.z);
          const prev = primary.pos;
          if (prev) {
            const dx = curr.x - prev.x;
            const dy = curr.y - prev.y;
            const dz = curr.z - prev.z;
            if (trigger) {
              // convert motion to orbit delta
              this.orbitYaw -= dx * poseRotScale * 0.001;
              this.orbitPitch = THREE.MathUtils.clamp(
                this.orbitPitch + dy * poseRotScale * 0.001,
                -Math.PI / 2 + 0.1,
                Math.PI / 2 - 0.1
              );
              this.showHint('Orbit');
            } else if (grip) {
              // translate target by controller motion
              // invert Y/Z as requested
              const pan = new THREE.Vector3(dx * posePanScale * 0.001, dy * posePanScale * 0.001, dz * posePanZScale);
              pan.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.orbitYaw);
              this.orbitTarget.add(pan);
              this.showHint('Pan');
            }
          }
          primary.pos = curr;
        }
      }
    }

    if (Math.abs(axX) > deadzone || Math.abs(axY) > deadzone) {
      if (trigger) {
        this.orbitYaw -= axX * yawSpeed;
        this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch - axY * pitchSpeed, -Math.PI / 2 + 0.1, Math.PI / 2 - 0.1);
        this.showHint('Orbit');
      } else if (grip) {
        const pan = new THREE.Vector3(axX, 0, axY).multiplyScalar(panSpeed * this.orbitRadius);
        pan.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.orbitYaw);
        this.orbitTarget.add(pan);
        this.showHint('Pan');
      } else {
        this.orbitRadius = THREE.MathUtils.clamp(this.orbitRadius + axX * zoomSpeed, 0.5, 6);
        this.showHint('Zoom');
      }
    }

    const dollyZ = -(this.orbitRadius - 2.0);
    const userRotation = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(this.orbitPitch, this.orbitYaw, 0, 'YXZ'));
    const orientation = this.sourceViewBaseOrientation.clone().multiply(userRotation);
    const dolly = new THREE.Vector3(0, 0, dollyZ).applyQuaternion(orientation);
    const position = this.orbitTarget.clone().add(dolly);
    const model = new THREE.Matrix4().compose(
      position,
      orientation,
      new THREE.Vector3(1, 1, 1)
    );
    // Zoom is a rigid dolly. Scaling only Z deforms calibrated metric geometry.
    this.meshModel.copy(model);
    this.updateDebugOverlay(primary, sources.length);
  }

  private logSources(added: readonly XRInputSource[] = [], removed: readonly XRInputSource[] = []): void {
    const info = {
      added: added.map((s) => ({ hand: s.handedness, gp: !!s.gamepad, axes: s.gamepad?.axes.length || 0, btn: s.gamepad?.buttons.length || 0 })),
      removed: removed.map((s) => ({ hand: s.handedness })),
    };
    this.logInput('[XR] sources ' + JSON.stringify(info));
  }

  private logInput(msg: string): void {
    if (import.meta.env.DEV) console.debug(msg);
    if (this.debugEl) {
      this.debugEl.textContent = msg;
    }
  }

  private showHint(label: string, durationMs = 1200, subtitle?: string): void {
    if (!this.hintCtx || !this.hintsEnabled) return;
    const ctx = this.hintCtx;
    const w = this.hintCanvas.width;
    const h = this.hintCanvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.70)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 8;
    ctx.strokeRect(16, 16, w - 32, h - 32);
    ctx.fillStyle = '#ffeb3b';
    ctx.font = 'bold 120px sans-serif';
    ctx.fillText(label, 60, 180);
    if (subtitle) {
      ctx.font = '60px sans-serif';
      ctx.fillStyle = '#ffffff';
      const lines = subtitle.split('\n');
      lines.forEach((line, i) => ctx.fillText(line, 60, 260 + i * 70));
    }
    const s = this.state;
    if (s) s.hintNeedsUpload = true;
    if (this.hintTimeout) {
      window.clearTimeout(this.hintTimeout);
    }
    this.hintTimeout = window.setTimeout(() => {
      ctx.clearRect(0, 0, w, h);
      if (s) s.hintNeedsUpload = true;
    }, durationMs);
  }

  private updateDebugOverlay(primary: ControllerState, sourcesLen: number): void {
    if (!this.debugEl) return;
  
    const fmt = (s: ControllerState) =>
      `${s.hand}: sel=${s.select ? 1 : 0} sq=${s.squeeze ? 1 : 0} ax=${s.axes
        .map((v) => v.toFixed(2))
        .join(",")}`;
  
    const gps =
      "getGamepads" in navigator && typeof navigator.getGamepads === "function"
        ? navigator.getGamepads()
        : [];
  
    const firstGp =
      gps && gps.length
        ? gps.find((g): g is Gamepad => !!g)
        : null;
  
    const gpTxt = firstGp
      ? `gp axes=${firstGp.axes.map((v) => v.toFixed(2)).join(",")} btn=${firstGp.buttons
          .map((b) => (b?.pressed ? 1 : 0))
          .join("")}`
      : "gp none";
  
    this.debugEl.textContent =
      `sources=${sourcesLen} | ${fmt(this.input.left)} | ${fmt(this.input.right)} | active=${primary.hand} | ${gpTxt}`;
  }
}
