import * as THREE from 'three';

export interface XRBridgeOptions {
  scene: THREE.Scene;
  leftCam: THREE.PerspectiveCamera;
  rightCam: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
}

export function drawThreeStereo(
  gl: WebGL2RenderingContext,
  layer: XRWebGLLayer,
  pose: XRViewerPose,
  _refSpace: XRReferenceSpace,
  opts: XRBridgeOptions
): void {
  const { scene, leftCam, rightCam, renderer } = opts;

  const cams = [leftCam, rightCam];
  renderer.state.reset();
  renderer.setRenderTarget(null);

  for (let i = 0; i < pose.views.length; i++) {
    const view = pose.views[i];
    const vp = layer.getViewport(view);
    if (!vp) continue;
    gl.viewport(vp.x, vp.y, vp.width, vp.height);
    gl.scissor(vp.x, vp.y, vp.width, vp.height);
    gl.enable(gl.SCISSOR_TEST);
    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const cam = cams[i] || cams[0];
    cam.projectionMatrix.fromArray(view.projectionMatrix as unknown as number[]);
    const viewMat = new THREE.Matrix4().fromArray(view.transform.matrix as unknown as number[]);
    const camMat = viewMat.invert();
    cam.matrix.copy(camMat);
    cam.matrix.decompose(cam.position, cam.quaternion, cam.scale);
    cam.updateMatrixWorld(true);

    renderer.setViewport(vp.x, vp.y, vp.width, vp.height);
    renderer.setScissor(vp.x, vp.y, vp.width, vp.height);
    renderer.setScissorTest(true);

    renderer.render(scene, cam);
  }
  renderer.setScissorTest(false);
}
