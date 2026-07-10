export const vertexShader = /* glsl */ `
  uniform sampler2D depthTexture;
  uniform float aspect;
  uniform float zScale;
  uniform float zBias;
  uniform float zGamma;
  uniform float zMaxClip;
  uniform float planeScale;
  uniform float projectionMix;
  uniform vec2 focalNorm;
  uniform vec2 principalUv;
  varying vec2 vUv;
  varying vec2 vSampleUv;

  float readDepth(vec2 uv) {
    return texture(depthTexture, uv).r;
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
    float reliefX = (0.5 - vUv.x) * aspect * planeScale;
    float reliefY = (0.5 - vUv.y) * planeScale;
    // Exact pinhole inverse projection in texture coordinates. principalUv uses
    // a bottom-left texture origin so it is shared by video and depth textures.
    float pinholeX = ((vSampleUv.x - principalUv.x) / focalNorm.x) * z;
    float pinholeY = ((vSampleUv.y - principalUv.y) / focalNorm.y) * z;
    float x = mix(reliefX, pinholeX, projectionMix);
    float y = mix(reliefY, pinholeY, projectionMix);
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
