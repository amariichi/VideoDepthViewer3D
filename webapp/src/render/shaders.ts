export const vertexShader = /* glsl */ `
  uniform sampler2D depthTexture;
  uniform vec2 depthSize;
  uniform float aspect;
  uniform float zScale;
  uniform float zBias;
  uniform float zGamma;
  uniform float zMaxClip;
  uniform float planeScale;
  uniform float projectionMix;
  uniform float tanHalfSourceFovY;
  varying vec2 vUv;
  varying vec2 vSampleUv;
  varying float vEdgeMetric;

  float readDepth(vec2 uv) {
    return texture(depthTexture, uv).r;
  }

  float shapeDepth(float rawDepth) {
    float depth = pow(max(rawDepth, 0.0), zGamma);
    return clamp(depth * zScale, 0.0, zMaxClip);
  }

  float relativeDiff(float a, float b) {
    return abs(a - b) / max(max(a, b), 1e-3);
  }

  void main() {
    vUv = uv;
    vSampleUv = vec2(1.0 - uv.x, 1.0 - uv.y);
    vec2 texel = vec2(1.0) / max(depthSize, vec2(1.0));
    float zDepth = shapeDepth(readDepth(vSampleUv));
    float z = zDepth + zBias;
    float leftDepth = shapeDepth(readDepth(vSampleUv + vec2(-texel.x, 0.0)));
    float rightDepth = shapeDepth(readDepth(vSampleUv + vec2(texel.x, 0.0)));
    float upDepth = shapeDepth(readDepth(vSampleUv + vec2(0.0, texel.y)));
    float downDepth = shapeDepth(readDepth(vSampleUv + vec2(0.0, -texel.y)));
    vEdgeMetric = max(
      max(relativeDiff(zDepth, leftDepth), relativeDiff(zDepth, rightDepth)),
      max(relativeDiff(zDepth, upDepth), relativeDiff(zDepth, downDepth))
    );
    float reliefX = (0.5 - vUv.x) * aspect * planeScale;
    float reliefY = (0.5 - vUv.y) * planeScale;
    // For pinhole mode, normalize the existing planeScale so the default value
    // stays close to a unit display scale.
    float pinholeSpread = (2.0 * tanHalfSourceFovY) * (0.5 * planeScale);
    float pinholeX = (0.5 - vUv.x) * aspect * pinholeSpread * z;
    float pinholeY = (0.5 - vUv.y) * pinholeSpread * z;
    float x = mix(reliefX, pinholeX, projectionMix);
    float y = mix(reliefY, pinholeY, projectionMix);
    vec4 displaced = vec4(x, y, -z, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * displaced;
  }
`;

export const fragmentShader = /* glsl */ `
  uniform sampler2D videoTexture;
  uniform float edgeDiscardThreshold;
  varying vec2 vUv;
  varying vec2 vSampleUv;
  varying float vEdgeMetric;

  void main() {
    if (edgeDiscardThreshold > 0.0 && vEdgeMetric > edgeDiscardThreshold) {
      discard;
    }
    vec4 color = texture(videoTexture, vSampleUv);
    gl_FragColor = color;
  }
`;
