export const vertexShader = /* glsl */ `
  uniform sampler2D depthTexture;
  uniform vec2 depthSize;
  uniform float aspect;
  uniform float zScale;
  uniform float zBias;
  uniform float zGamma;
  uniform float zMaxClip;
  uniform float planeScale;
  varying vec2 vUv;
  varying vec2 vSampleUv;
  varying vec3 vNormal;

  float readDepth(vec2 uv) {
    vec2 texel = uv;
    return texture(depthTexture, texel).r;
  }

  void main() {
    vUv = uv;
    vSampleUv = vec2(1.0 - uv.x, 1.0 - uv.y);
    float depth = readDepth(vSampleUv);
    depth = pow(max(depth, 0.0), zGamma);
    // Apply clipping to the depth-derived displacement only.
    // Z Bias is a global offset and should not participate in clipping, otherwise
    // non-zero bias easily saturates to a constant Z and the mesh appears flat.
    float zDepth = clamp(depth * zScale, 0.0, zMaxClip);
    float z = zDepth + zBias;
    float x = (0.5 - vUv.x) * aspect * planeScale;
    float y = (0.5 - vUv.y) * planeScale;
    vec4 displaced = vec4(x, y, -z, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * displaced;
  }
`;

export const fragmentShader = /* glsl */ `
  uniform sampler2D videoTexture;
  varying vec2 vUv;
  varying vec2 vSampleUv;

  void main() {
    vec4 color = texture(videoTexture, vSampleUv);
    gl_FragColor = color;
  }
`;
