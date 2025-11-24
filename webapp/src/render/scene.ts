import * as THREE from 'three';
// Keep import for styles, but we'll manage the button click ourselves to try fallback feature sets.
// VRButton unused (RawXRに統一)
import type { DepthFrame, ViewerControls } from '../types';
import { createGridGeometry } from './mesh';
import { fragmentShader, vertexShader } from './shaders';
import { perfStats } from '../utils/perfStats';

export class RenderScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private sbsLeftCam: THREE.PerspectiveCamera;
  private sbsRightCam: THREE.PerspectiveCamera;
  private mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  private depthTexture: THREE.DataTexture;
  private videoTexture: THREE.VideoTexture | null = null;
  private container: HTMLElement;
  // VRボタン/three.js XRは使わない（RawXRに統一）
  private currentControls: ViewerControls;
  private lgPolyfillLoaded = false;
  private orbitYaw = 0;
  private orbitPitch = 0;
  private orbitRadius = 3.5;
  private orbitTarget = new THREE.Vector3(0, 1.4, 0);
  private readonly orbitSpeed = 0.05;
  private readonly panSpeed = 0.05;
  private readonly zoomSpeed = 1.5;
  private readonly defaultTarget = new THREE.Vector3(0, 1.4, 0);
  private readonly xrTarget = new THREE.Vector3(0, 0.6, -1.0);
  private readonly ipd = 0.064; // meters
  private sbsEnabled = false;
  private vrYOffset = -1.4; // lower content in VR so中心が目線に来る
  private instructionBillboard: THREE.Sprite | null = null;
  private instructionsVisible = true;
  // Hooks to provide scene/cameras to RawXR stereo bridge
  public rawXRScene: THREE.Scene | null = null;
  public rawXRLeftCam: THREE.PerspectiveCamera | null = null;
  public rawXRRightCam: THREE.PerspectiveCamera | null = null;
  private rawXRSession: XRSession | null = null;
  private rawXRRefSpace: XRReferenceSpace | null = null;
  private rawXRLoopHandle: number | null = null;
  private rawXRCams: [THREE.PerspectiveCamera, THREE.PerspectiveCamera] = [
    new THREE.PerspectiveCamera(50, 1, 0.01, 1000),
    new THREE.PerspectiveCamera(50, 1, 0.01, 1000),
  ];
  private rawXRViewport = new THREE.Vector4();

  constructor(
    container: HTMLElement,
    initialControls: ViewerControls,
    video: HTMLVideoElement,
    _vrButtonParent?: HTMLElement
  ) {
    this.container = container;
    this.currentControls = initialControls;

    const canvas = this.createCanvas();
    // Create XR-compatible WebGL2 context explicitly (matches RawXRTest path).
    const gl = canvas.getContext('webgl2', { xrCompatible: true, antialias: true }) as WebGL2RenderingContext | null;
    if (!gl) {
      throw new Error('WebGL2 context unavailable');
    }
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      canvas,
      context: gl,
      alpha: false,
      preserveDrawingBuffer: false,
    });
    if (typeof (gl as any).makeXRCompatible === 'function') {
      (gl as any).makeXRCompatible().catch((err: unknown) => console.warn('makeXRCompatible failed', err));
    }
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.xr.enabled = true;
    // Default; actual space set per session request attempt.
    this.renderer.xr.setReferenceSpaceType('local');
    this.renderer.xr.addEventListener('sessionstart', () => this.onXRSessionStart());
    this.renderer.xr.addEventListener('sessionend', () => this.onXRSessionEnd());
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#202020');
    // Simple lighting for debug cube (depth shader is unlit, but cube helps visibility).
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);
    const point = new THREE.PointLight(0xffffff, 0.8);
    point.position.set(2, 3, 2);
    this.scene.add(point);
    this.camera = new THREE.PerspectiveCamera(initialControls.fovY, this.aspectRatio(), 0.01, 1000);
    this.camera.position.set(0, 1.4, this.orbitRadius);
    this.camera.lookAt(this.orbitTarget);
    this.sbsLeftCam = this.camera.clone();
    this.sbsRightCam = this.camera.clone();
    this.depthTexture = new THREE.DataTexture(new Float32Array([0]), 1, 1, THREE.RedFormat, THREE.FloatType);
    this.depthTexture.needsUpdate = true;
    this.videoTexture = new THREE.VideoTexture(video);
    this.videoTexture.colorSpace = THREE.SRGBColorSpace;
    this.rebuildMesh(1920 / 1080);
    this.attachVRButton();
    this.attachMouseOrbitControls();
    this.rawXRScene = this.scene;
    this.rawXRLeftCam = this.rawXRCams[0];
    this.rawXRRightCam = this.rawXRCams[1];
    this.createInstructionBillboard();
    window.addEventListener('resize', () => this.handleResize());
    if (import.meta.env.DEV) {
      (window as typeof window & { __renderScene?: RenderScene }).__renderScene = this;
    }
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  // Expose for RawXR three-bridge
  public getScene(): THREE.Scene { return this.scene; }
  public getLeftCam(): THREE.PerspectiveCamera { return this.rawXRCams[0]; }
  public getRightCam(): THREE.PerspectiveCamera { return this.rawXRCams[1]; }
  public getRenderer(): THREE.WebGLRenderer { return this.renderer; }

  private createCanvas(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    this.container.appendChild(canvas);
    // Avoid default context loss behavior; we'll try to restore.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('WebGL context lost');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      console.info('WebGL context restored');
    });
    return canvas;
  }

  private attachVRButton(): void {
    // three.jsのVRButtonは使用しない（RawXRでVRを扱うため非表示）
  }

  // three.js XR session logic removed（RawXRを使用）

  private aspectRatio(): number {
    return this.container.clientWidth / Math.max(this.container.clientHeight, 1);
  }

  private handleResize(): void {
    const aspect = this.aspectRatio();
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    // When XR is presenting, Three.js manages layer size; avoid resizing to silence warnings.
    if (!this.renderer.xr.isPresenting) {
      this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    }
  }

  public setSbsEnabled(enabled: boolean): void {
    this.sbsEnabled = enabled;
    // Recompute camera aspect immediately to avoid squashing on first frame
    this.handleResize();
  }

  public isSbsEnabled(): boolean {
    return this.sbsEnabled;
  }

  public setInstructionsVisible(visible: boolean): void {
    this.instructionsVisible = visible;
    if (this.instructionBillboard) {
      this.instructionBillboard.visible = visible && !!this.instructionBillboard.parent;
    }
  }

  private createInstructionBillboard(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 42px sans-serif';
    ctx.fillText('VRコントローラ操作', 40, 70);
    ctx.font = '32px sans-serif';
    const lines = [
      'スティック: ズーム(+X) / FOV(-Y)',
      'トリガー+スティック: オービット',
      'グリップ+スティック: パン'
    ];
    lines.forEach((l, i) => ctx.fillText(l, 40, 130 + i * 50));

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.4, 0.4, 1);
    sprite.position.set(0, 0, -1.2);
    sprite.visible = false;
    this.instructionBillboard = sprite;
  }

  private attachInstructionBillboard(): void {
    if (!this.instructionBillboard || !this.instructionsVisible) return;
    const xrCam = this.renderer.xr.getCamera();
    xrCam.add(this.instructionBillboard);
    this.instructionBillboard.visible = true;
  }

  private detachInstructionBillboard(): void {
    if (!this.instructionBillboard) return;
    this.instructionBillboard.visible = false;
    this.instructionBillboard.parent?.remove(this.instructionBillboard);
  }

  updateControls(patch: Partial<ViewerControls>): void {
    this.currentControls = { ...this.currentControls, ...patch };
    this.camera.fov = this.currentControls.fovY;
    this.camera.updateProjectionMatrix();
    if (this.mesh) {
      const uniforms = this.mesh.material.uniforms;
      uniforms.zScale.value = this.currentControls.zScale;
      uniforms.zBias.value = this.currentControls.zBias;
      uniforms.zGamma.value = this.currentControls.zGamma;
      uniforms.zMaxClip.value = this.currentControls.zMaxClip;
      uniforms.planeScale.value = this.currentControls.planeScale;
      this.mesh.position.y = this.currentControls.yOffset;
    }
  }

  updateVideo(video: HTMLVideoElement): void {
    this.videoTexture?.dispose();
    this.videoTexture = new THREE.VideoTexture(video);
    this.videoTexture.minFilter = THREE.LinearFilter;
    this.videoTexture.magFilter = THREE.LinearFilter;
    this.videoTexture.colorSpace = THREE.SRGBColorSpace;
    if (this.mesh) {
      this.mesh.material.uniforms.videoTexture.value = this.videoTexture;
    }
  }

  updateDepth(frame: DepthFrame, controls: ViewerControls): void {
    if (!this.mesh) return;
    const start = performance.now();
    if (import.meta.env.DEV) {
      console.debug('updateDepth', frame.width, frame.height, frame.data[0]);
    }
    if (this.depthTexture.image.width === frame.width && this.depthTexture.image.height === frame.height) {
      this.depthTexture.image.data = frame.data;
      this.depthTexture.needsUpdate = true;
    } else {
      const tex = new THREE.DataTexture(frame.data, frame.width, frame.height, THREE.RedFormat, THREE.FloatType);
      tex.needsUpdate = true;
      tex.flipY = true;
      this.depthTexture.dispose();
      this.depthTexture = tex;
      this.mesh.material.uniforms.depthTexture.value = this.depthTexture;
    }
    const uniforms = this.mesh.material.uniforms;
    uniforms.aspect.value = frame.width / frame.height;
    uniforms.zScale.value = controls.zScale;
    uniforms.zBias.value = controls.zBias;
    uniforms.zGamma.value = controls.zGamma;
    uniforms.zMaxClip.value = Math.min(controls.zMaxClip, frame.zMax);
    uniforms.planeScale.value = controls.planeScale;
    const yOffset = this.renderer.xr.isPresenting ? controls.yOffset + this.vrYOffset : controls.yOffset;
    this.mesh.position.y = yOffset;
    perfStats.add('scene.updateDepth', performance.now() - start);
  }

  updateMeshResolution(aspect: number, controls: ViewerControls): void {
    this.rebuildMesh(aspect, controls);
  }

  private rebuildMesh(aspect: number, controls: ViewerControls = this.currentControls): void {
    const start = performance.now();
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }
    const geometry = createGridGeometry({ aspect, targetTriangles: controls.targetTriangles });
    const material = new THREE.ShaderMaterial({
      uniforms: {
        depthTexture: { value: this.depthTexture },
        videoTexture: { value: this.videoTexture },
        depthSize: { value: new THREE.Vector2(1, 1) },
        aspect: { value: aspect },
        zScale: { value: controls.zScale },
        zBias: { value: controls.zBias },
        zGamma: { value: controls.zGamma },
        zMaxClip: { value: controls.zMaxClip },
        planeScale: { value: controls.planeScale },
      },
      vertexShader,
      fragmentShader,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.set(0, controls.yOffset, 0.0);
    this.scene.add(this.mesh);
    perfStats.add('scene.rebuildMesh', performance.now() - start);
    this.startLoop();
  }

  private renderLoop?: () => void;
  private loopAttached = false;

  private startLoop(): void {
    if (!this.renderLoop) {
      this.renderLoop = () => {
        const start = performance.now();
        const presenting = this.renderer.xr.isPresenting;
        // Force clear color extremely vivid in XR to detect rendering path.
        if (presenting) {
          this.renderer.setClearColor(0xff0000, 1);
          this.updateFromVRControllers();
        } else {
          this.renderer.setClearColor(0x202020, 1);
        }
        if (this.sbsEnabled) {
          this.renderSideBySide();
        } else {
          this.renderer.setScissorTest(false);
          this.renderer.render(this.scene, this.camera);
        }
        perfStats.add('scene.render', performance.now() - start);
        perfStats.checkLog();
      };
    }
    if (this.loopAttached) return;
    this.renderer.setAnimationLoop(this.renderLoop);
    this.loopAttached = true;
  }

  public pauseLoop(): void {
    if (!this.loopAttached) return;
    this.renderer.setAnimationLoop(null);
    this.loopAttached = false;
  }

  private renderSideBySide(): void {
    const w = this.container.clientWidth;
    const h = Math.max(this.container.clientHeight, 1);
    const halfW = w / 2;

    // Update stereo cameras from main camera pose
    this.sbsLeftCam.copy(this.camera);
    this.sbsRightCam.copy(this.camera);
    this.sbsLeftCam.aspect = halfW / h;
    this.sbsRightCam.aspect = halfW / h;
    this.sbsLeftCam.updateProjectionMatrix();
    this.sbsRightCam.updateProjectionMatrix();

    const right = new THREE.Vector3();
    this.camera.getWorldDirection(right);
    right.cross(this.camera.up).normalize();
    const offset = right.multiplyScalar(this.ipd / 2);
    this.sbsLeftCam.position.sub(offset);
    this.sbsRightCam.position.add(offset);

    this.renderer.setScissorTest(true);

    // left
    this.renderer.setViewport(0, 0, halfW, h);
    this.renderer.setScissor(0, 0, halfW, h);
    this.renderer.render(this.scene, this.sbsLeftCam);

    // right
    this.renderer.setViewport(halfW, 0, halfW, h);
    this.renderer.setScissor(halfW, 0, halfW, h);
    this.renderer.render(this.scene, this.sbsRightCam);

    this.renderer.setScissorTest(false);
  }

  public resize(): void {
    this.handleResize();
  }

  public resetView(): void {
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.orbitRadius = 3.5;
    this.orbitTarget.copy(this.defaultTarget);
    this.updateCameraOrbit();
  }

  private onXRSessionStart(): void {
    // XR空間ではカメラ姿勢はHMDに委ねられるので、メッシュを視界に置く。
    this.setMeshForXR(true);
    this.attachInstructionBillboard();
  }

  private onXRSessionEnd(): void {
    // After exit, restore renderer size to match the DOM so 2D view looks correct.
    this.handleResize();
    this.setMeshForXR(false);
    this.detachInstructionBillboard();
  }

  private setMeshForXR(inXR: boolean): void {
    if (!this.mesh) return;
    const target = inXR ? this.xrTarget : this.defaultTarget;
    this.orbitTarget.copy(target);
    // Place mesh so its center is in front of the user in XR; keep y offset similar.
    const yOffset = inXR ? this.vrYOffset : 0;
    this.mesh.position.set(target.x, target.y + yOffset, target.z);
    // Keep camera orbit radius modest so controllers start close to the content.
    if (inXR) {
      this.orbitRadius = 2.5;
      this.orbitYaw = 0;
      this.orbitPitch = 0;
    }
    this.updateCameraOrbit();

  }

  /**
   * Minimal VR controller mapping:
   * - Hold trigger to orbit around the target using the thumbstick (yaw/pitch).
   * - Hold grip to pan the target position (X/Z).
   * - No buttons pressed: thumbstick adjusts zoom/FOV (X = dolly, Y = FOV).
   */
  private updateFromVRControllers(): void {
    const session = this.renderer.xr.getSession();
    if (!session) return;

    for (const source of session.inputSources) {
      const gp = source.gamepad;
      if (!gp || gp.axes.length < 2) continue;

      const [axX, axY] = gp.axes;
      const triggerPressed = gp.buttons[0]?.pressed ?? false; // primary/trigger
      const gripPressed = gp.buttons[1]?.pressed ?? false; // squeeze/grip

      if (triggerPressed) {
        this.orbitYaw -= axX * this.orbitSpeed;
        this.orbitPitch = THREE.MathUtils.clamp(
          this.orbitPitch - axY * this.orbitSpeed,
          -Math.PI / 2 + 0.1,
          Math.PI / 2 - 0.1
        );
      } else if (gripPressed) {
        const pan = new THREE.Vector3(axX, 0, axY).multiplyScalar(this.panSpeed * this.orbitRadius);
        pan.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.orbitYaw);
        this.orbitTarget.add(pan);
      } else {
        // Zoom / FOV adjustments without modifiers
        this.orbitRadius = THREE.MathUtils.clamp(this.orbitRadius + axX * 0.1, 0.6, 10);
        this.camera.fov = THREE.MathUtils.clamp(this.camera.fov - axY * this.zoomSpeed, 35, 95);
        this.camera.updateProjectionMatrix();
      }
    }

    this.updateCameraOrbit();
  }

  private updateCameraOrbit(): void {
    const x = this.orbitTarget.x + this.orbitRadius * Math.cos(this.orbitPitch) * Math.sin(this.orbitYaw);
    const y = this.orbitTarget.y + this.orbitRadius * Math.sin(this.orbitPitch);
    const z = this.orbitTarget.z + this.orbitRadius * Math.cos(this.orbitPitch) * Math.cos(this.orbitYaw);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.orbitTarget);
  }

  private attachMouseOrbitControls(): void {
    const dom = this.renderer.domElement;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let isPanning = false;

    dom.addEventListener('contextmenu', (e) => e.preventDefault());

    dom.addEventListener('mousedown', (e) => {
      dragging = true;
      isPanning = e.button === 2; // right button = pan, left button = orbit
      lastX = e.clientX;
      lastY = e.clientY;
    });
    window.addEventListener('mouseup', () => {
      dragging = false;
    });
    dom.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;

      if (isPanning) {
        const scale = this.orbitRadius * 0.002;
        const pan = new THREE.Vector3();
        const dir = new THREE.Vector3();
        this.camera.getWorldDirection(dir);
        const right = new THREE.Vector3().crossVectors(dir, this.camera.up).normalize();
        const up = new THREE.Vector3().copy(this.camera.up).normalize();
        pan.addScaledVector(right, -dx * scale);
        pan.addScaledVector(up, dy * scale);
        this.orbitTarget.add(pan);
        this.camera.position.add(pan);
        this.camera.lookAt(this.orbitTarget);
      } else {
        this.orbitYaw -= dx * 0.005;
        // Invert vertical mouse direction: dragging up tilts camera up.
        this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch + dy * 0.005, -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05);
        this.updateCameraOrbit();
      }
    });
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.orbitRadius = THREE.MathUtils.clamp(this.orbitRadius + e.deltaY * 0.002, 0.6, 10);
      this.updateCameraOrbit();
    }, { passive: false });
  }

  async startLookingGlass(): Promise<void> {
    if (!this.lgPolyfillLoaded) {
      await this.loadLookingGlassPolyfill();
      this.lgPolyfillLoaded = true;
    }
    if (!('xr' in navigator)) {
      throw new Error('WebXR is not supported in this browser (after polyfill)');
    }
    const sessionTypes = ['immersive-vr', 'immersive-ar'] as const;
    let session: XRSession | null = null;
    let lastError: unknown = null;
    for (const type of sessionTypes) {
      try {
        session = await navigator.xr!.requestSession(type, {
          requiredFeatures: [],
          optionalFeatures: ['local-floor', 'viewer'],
        });
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!session) {
      throw lastError ?? new Error('XR session could not be created');
    }
    await this.renderer.xr.setSession(session);
    session.addEventListener('end', () => {
      // no-op
    });
  }

  async endXR(): Promise<void> {
    const session = this.renderer.xr.getSession();
    if (session) {
      await session.end();
    }
    if (this.rawXRSession) {
      await this.stopManualXR();
    }
  }

  // Manual XR pipeline using three.js renderer but our own XRWebGLLayer
  async startManualXR(): Promise<void> {
    if (this.rawXRSession) return;
    if (!('xr' in navigator)) {
      throw new Error('WebXR未対応ブラウザ');
    }
    const supported = await navigator.xr!.isSessionSupported('immersive-vr');
    if (!supported) throw new Error('immersive-vr not supported');

    // Disable three.js internal XR path to avoid interference.
    const prevEnabled = this.renderer.xr.enabled;
    this.renderer.xr.enabled = false;

    const gl = this.renderer.getContext();
    const session = await navigator.xr!.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'local'],
    });
    const layer = new XRWebGLLayer(session, gl as unknown as WebGLRenderingContext);
    session.updateRenderState({ baseLayer: layer });

    let refSpace: XRReferenceSpace;
    try {
      refSpace = await session.requestReferenceSpace('local-floor');
    } catch {
      refSpace = await session.requestReferenceSpace('local');
    }

    this.rawXRSession = session;
    this.rawXRRefSpace = refSpace;
    session.addEventListener('end', () => {
      this.stopManualXR();
    });
    // remember state to restore when stopping
    (this.renderer.xr as any)._manualPrevEnabled = prevEnabled;
    this.manualXRLoop();
  }

  private async stopManualXR(): Promise<void> {
    if (this.rawXRLoopHandle && this.rawXRSession) {
      this.rawXRSession.cancelAnimationFrame(this.rawXRLoopHandle);
    }
    if (this.rawXRSession) {
      try {
        await this.rawXRSession.end();
      } catch {
        /* ignore */
      }
    }
    this.rawXRSession = null;
    this.rawXRRefSpace = null;
    this.rawXRLoopHandle = null;
    // restore three.js XR flag if we disabled it
    const prev = (this.renderer.xr as any)._manualPrevEnabled;
    if (typeof prev === 'boolean') {
      this.renderer.xr.enabled = prev;
      (this.renderer.xr as any)._manualPrevEnabled = undefined;
    }
  }

  private manualXRLoop(): void {
    if (!this.rawXRSession) return;
    this.rawXRLoopHandle = this.rawXRSession.requestAnimationFrame((t, frame) => this.onManualXRFrame(t, frame));
  }

  private onManualXRFrame(_time: DOMHighResTimeStamp, frame: XRFrame): void {
    if (!this.rawXRSession || !this.rawXRRefSpace) return;
    const pose = frame.getViewerPose(this.rawXRRefSpace);
    if (!pose) {
      this.manualXRLoop();
      return;
    }
    const gl = this.renderer.getContext();
    const layer = this.rawXRSession.renderState.baseLayer as XRWebGLLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);

    // reset state to avoid carry-over between eyes
    this.renderer.state.reset();
    // ensure three.js knows we render to the default target (which is XR layer fb now)
    this.renderer.setRenderTarget(null);

    for (let i = 0; i < pose.views.length; i++) {
      const view = pose.views[i];
      const vp = layer.getViewport(view);
      if (!vp) continue;
      gl.viewport(vp.x, vp.y, vp.width, vp.height);
      gl.scissor(vp.x, vp.y, vp.width, vp.height);
      gl.enable(gl.SCISSOR_TEST);
      gl.clearColor(1.0, 0.0, 0.0, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      const cam = this.rawXRCams[i] || this.rawXRCams[0];
      cam.projectionMatrix.fromArray(view.projectionMatrix as unknown as number[]);
      const viewMat = new THREE.Matrix4().fromArray(view.transform.matrix as unknown as number[]);
      const camMat = viewMat.invert();
      cam.matrix.copy(camMat);
      cam.matrix.decompose(cam.position, cam.quaternion, cam.scale);
      cam.updateMatrixWorld(true);

      // ensure renderer uses this viewport for internal state
      this.rawXRViewport.set(vp.x, vp.y, vp.width, vp.height);
      this.renderer.setViewport(this.rawXRViewport.x, this.rawXRViewport.y, this.rawXRViewport.z, this.rawXRViewport.w);
      this.renderer.setScissor(this.rawXRViewport.x, this.rawXRViewport.y, this.rawXRViewport.z, this.rawXRViewport.w);
      this.renderer.setScissorTest(true);

      this.renderer.render(this.scene, cam);
    }
    this.renderer.setScissorTest(false);
    // keep billboard attached if visible
    this.manualXRLoop();
  }

  private async loadLookingGlassPolyfill(): Promise<void> {
    // official polyfill load (no types available)
    const anyWin = window as typeof window & { __lgPolyfill?: boolean };
    if (anyWin.__lgPolyfill) return;
    // Prefer local dependency; fallback to CDN 0.6.0
    const urls = [
      '@lookingglass/webxr/dist/bundle/webxr.js',
      'https://unpkg.com/@lookingglass/webxr@0.6.0/dist/bundle/webxr.js',
    ];
    let mod: any = null;
    for (const url of urls) {
      try {
        mod = await import(/* @vite-ignore */ url);
        break;
      } catch (err) {
        console.warn('LG polyfill load failed', url, err);
      }
    }
    if (!mod) {
      throw new Error('Looking Glass polyfill could not be loaded');
    }
    const Polyfill = mod?.LookingGlassWebXRPolyfill;
    if (!Polyfill) {
      throw new Error('LookingGlassWebXRPolyfill not found');
    }
    // Instantiate with defaults; users can tune via global config if needed
    new Polyfill({});
    anyWin.__lgPolyfill = true;
  }
}
