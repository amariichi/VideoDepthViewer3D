import type { DepthFrame } from '../types';
import type { EffectiveGeometryControls } from './projection';

export const FRONT_SAFETY_MAX_VIOLATION_FRACTION = 0.2;
export const FRONT_SAFETY_SAMPLE_INTERVAL_MS = 500;
export const LOOKING_GLASS_MAX_FRONT_FRACTION = 0.08;
export const LOOKING_GLASS_LATER_INCREASE_CONFIRMATION_SAMPLES = 3;
export const LOOKING_GLASS_AUTO_REBASE_NEAR_QUANTILE = 0.01;
export const LOOKING_GLASS_AUTO_CONVERGENCE_FRONT_QUANTILE = 0.1;
export const LOOKING_GLASS_AUTO_CONVERGENCE_CROWDED_QUANTILE = 0.2;
export const LOOKING_GLASS_AUTO_CONVERGENCE_HISTORY = 3;
export const LOOKING_GLASS_AUTO_CONVERGENCE_SAMPLE_INTERVAL_MS = 250;
export const LOOKING_GLASS_AUTO_CONVERGENCE_FAST_RESPONSE_RATE = 10;
export const LOOKING_GLASS_AUTO_CONVERGENCE_FAST_RESPONSE_MS = 750;
export const LOOKING_GLASS_AUTO_CONVERGENCE_NORMAL_RESPONSE_RATE = 2;
export const LOOKING_GLASS_SOURCE_DEPTH_SCALE_RANGE = {
  min: 0.01,
  max: 20,
} as const;
export const LOOKING_GLASS_NEAR_CLIP_MARGIN_FRACTION = 0.01;
export const LOOKING_GLASS_NEAR_CLIP_MIN_MARGIN = 0.005;
export const WEBXR_MIN_INITIAL_EYE_DISTANCE = 0.5;

export interface XRFrontSafetyProfile {
  mode: 'looking-glass' | 'webxr';
  targetZ?: number;
  targetDiameter?: number;
  /** Uniform clip X/Y scale used to letterbox calibrated source framing. */
  projectionScale?: number;
  /** Looking Glass projection scale without the calibrated source-fit term. */
  projectionZoom?: number;
  /** Keep the calibrated source-camera apex fixed instead of translating mesh Z. */
  preserveSourceProjection?: boolean;
  /** Looking Glass-only, view-baseline convergence driven by recent depth. */
  autoConvergence?: boolean;
  projectionPanX?: number;
  projectionPanY?: number;
}

export interface NormalizedDepthSampleRegion {
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
}

export function shouldApplyRigidFrontSafety(
  profile: XRFrontSafetyProfile
): boolean {
  return !(
    profile.mode === 'looking-glass' &&
    profile.preserveSourceProjection === true
  );
}

export function estimateRenderedNearDepth(
  frame: DepthFrame,
  controls: EffectiveGeometryControls,
  zMaxClip: number,
  maxViolationFraction = FRONT_SAFETY_MAX_VIOLATION_FRACTION,
  maxSamples = 2048
): number | null {
  return estimateRenderedDepthQuantiles(
    frame,
    controls,
    zMaxClip,
    [maxViolationFraction],
    maxSamples
  )?.[0] ?? null;
}

/**
 * Estimate several depth percentiles from one sparse traversal and one sort.
 * Keeping this shared avoids repeating the most expensive part of the
 * Looking Glass auto-placement sample for its 10% and 20% boundaries.
 */
export function estimateRenderedDepthQuantiles(
  frame: DepthFrame,
  controls: EffectiveGeometryControls,
  zMaxClip: number,
  quantiles: readonly number[],
  maxSamples = 2048,
  sampleRegion: NormalizedDepthSampleRegion | null = null,
  minValidSamples = 1
): number[] | null {
  const width = Math.max(0, Math.floor(frame.width));
  const height = Math.max(0, Math.floor(frame.height));
  if (
    width === 0 ||
    height === 0 ||
    frame.data.length < width * height ||
    quantiles.length === 0
  ) {
    return null;
  }

  const clampUnit = (value: number, fallback: number): number =>
    Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : fallback;
  const minU = sampleRegion ? clampUnit(sampleRegion.minU, 0) : 0;
  const maxU = sampleRegion ? clampUnit(sampleRegion.maxU, 1) : 1;
  const minV = sampleRegion ? clampUnit(sampleRegion.minV, 0) : 0;
  const maxV = sampleRegion ? clampUnit(sampleRegion.maxV, 1) : 1;
  if (maxU <= minU || maxV <= minV) return null;

  const lastX = width - 1;
  const lastY = height - 1;
  const minX = Math.min(lastX, Math.max(0, Math.ceil(minU * lastX)));
  const maxX = Math.min(lastX, Math.max(0, Math.floor(maxU * lastX)));
  const minY = Math.min(lastY, Math.max(0, Math.ceil(minV * lastY)));
  const maxY = Math.min(lastY, Math.max(0, Math.floor(maxV * lastY)));
  if (maxX < minX || maxY < minY) return null;

  const regionWidth = maxX - minX + 1;
  const regionHeight = maxY - minY + 1;
  const sampleBudget = Math.max(1, Math.floor(maxSamples));
  const stride = Math.max(
    1,
    Math.ceil(Math.sqrt((regionWidth * regionHeight) / sampleBudget))
  );
  const clip = Number.isFinite(zMaxClip) && zMaxClip > 0
    ? zMaxClip
    : Number.POSITIVE_INFINITY;
  const values: number[] = [];

  const xStart = minX + Math.min(Math.floor(stride / 2), regionWidth - 1);
  const yStart = minY + Math.min(Math.floor(stride / 2), regionHeight - 1);
  for (let y = yStart; y <= maxY; y += stride) {
    const row = y * width;
    for (let x = xStart; x <= maxX; x += stride) {
      const raw = frame.data[row + x];
      if (!Number.isFinite(raw) || raw <= 0) continue;
      const shaped = Math.pow(raw, controls.zGamma);
      const depth = Math.min(
        Math.max(shaped * controls.zScale, 0),
        clip
      ) + controls.zBias;
      if (!Number.isFinite(depth)) continue;
      values.push(Math.max(depth, 0));
    }
  }

  const requiredSamples = Math.max(1, Math.floor(minValidSamples));
  if (values.length < requiredSamples) return null;
  values.sort((a, b) => a - b);
  return quantiles.map((quantile) => {
    const bounded = Number.isFinite(quantile)
      ? Math.min(Math.max(quantile, 0), 1)
      : 0;
    const position = (values.length - 1) * bounded;
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.ceil(position);
    const mix = position - lowerIndex;
    return values[lowerIndex] * (1 - mix) + values[upperIndex] * mix;
  });
}

export type LookingGlassAutoConvergenceUrgency =
  | 'normal'
  | 'scene-change'
  | 'crowded-front'
  | 'all-behind';

/**
 * Use the 20% boundary as the zero-parallax target. The nearer 10% boundary
 * remains an urgency signal, but targeting it leaves roughly 90% of a scene
 * behind the display plane and can look persistently distant/soft.
 */
export function getLookingGlassAutoConvergenceTarget(
  frontBoundaryZ: number,
  crowdedBoundaryZ: number
): number | null {
  if (Number.isFinite(crowdedBoundaryZ)) return crowdedBoundaryZ;
  if (Number.isFinite(frontBoundaryZ)) return frontBoundaryZ;
  return null;
}

export type LookingGlassSourceDepthRebaseReason =
  | 'all-behind'
  | 'crowded-front';

export interface LookingGlassSourceDepthScaleRebaseInput {
  /** Fixed source-camera apex used as the center of uniform XYZ scaling. */
  sourceOriginZ: number;
  /** Mean quilt camera Z; coincides with sourceOriginZ in fixed Source View. */
  cameraCenterZ: number;
  configuredTargetZ: number;
  /** World Z of the robust nearest 1% depth boundary. */
  robustNearBoundaryZ: number;
  /** World Z of the 20% occupancy boundary. */
  crowdedBoundaryZ: number;
  currentScale: number;
  targetDiameter: number;
  baselineScaleMin?: number;
  baselineScaleMax?: number;
}

export interface LookingGlassSourceDepthScaleRebase {
  scale: number;
  scaleFactor: number;
  reason: LookingGlassSourceDepthRebaseReason;
  limited: boolean;
  farReachableTargetZ: number;
  nearReachableTargetZ: number;
}

export interface LookingGlassSourceNearClipRebaseInput {
  /** Unscaled robust q1 depth measured back from the fixed source apex. */
  robustNearDepth: number;
  currentScale: number;
  /** Actual vendor capture diameter, before projection-only source fitting. */
  targetDiameter: number;
  fovYRadians: number;
  depthNear: number;
  marginFraction?: number;
}

export interface LookingGlassSourceNearClipRebase {
  scale: number;
  scaleFactor: number;
  currentNearDepth: number;
  requiredNearDepth: number;
  limited: boolean;
}

/**
 * Reproduce @lookingglass/webxr's camera-space near plane. The vendor shifts
 * WebXR depthNear by focalDistance - targetDiameter to describe its capture
 * volume, then hard-clamps the final distance to 0.01.
 */
export function getLookingGlassNearPlaneDistance(
  targetDiameter: number,
  fovYRadians: number,
  depthNear: number
): number | null {
  if (
    !Number.isFinite(targetDiameter) ||
    targetDiameter <= 0 ||
    !Number.isFinite(fovYRadians) ||
    fovYRadians <= 0 ||
    fovYRadians >= Math.PI ||
    !Number.isFinite(depthNear)
  ) {
    return null;
  }
  const tanHalfFov = Math.tan(fovYRadians / 2);
  if (!Number.isFinite(tanHalfFov) || tanHalfFov <= Number.EPSILON) {
    return null;
  }
  const focalDistance = 0.5 * targetDiameter / tanHalfFov;
  const clipPlaneBias = focalDistance - targetDiameter;
  return Math.max(clipPlaneBias + Math.max(depthNear, 0), 0.01);
}

/**
 * Expand XYZ uniformly about the fixed source apex only when robust q1 would
 * be discarded by the vendor near plane. This preserves every central source
 * ray while reducing hard black clipping to at most the ignored q1 tail.
 */
export function getLookingGlassSourceNearClipRebase({
  robustNearDepth,
  currentScale,
  targetDiameter,
  fovYRadians,
  depthNear,
  marginFraction = LOOKING_GLASS_NEAR_CLIP_MARGIN_FRACTION,
}: LookingGlassSourceNearClipRebaseInput): LookingGlassSourceNearClipRebase | null {
  if (!Number.isFinite(robustNearDepth) || robustNearDepth <= 0) return null;
  const nearPlaneDistance = getLookingGlassNearPlaneDistance(
    targetDiameter,
    fovYRadians,
    depthNear
  );
  if (nearPlaneDistance === null) return null;

  const safeCurrentScale = Number.isFinite(currentScale) && currentScale > 0
    ? currentScale
    : 1;
  const safeMarginFraction = Number.isFinite(marginFraction)
    ? Math.max(marginFraction, 0)
    : LOOKING_GLASS_NEAR_CLIP_MARGIN_FRACTION;
  const requiredNearDepth =
    nearPlaneDistance +
    Math.max(
      LOOKING_GLASS_NEAR_CLIP_MIN_MARGIN,
      targetDiameter * safeMarginFraction
    );
  const currentNearDepth = robustNearDepth * safeCurrentScale;
  if (currentNearDepth >= requiredNearDepth - 1e-6) return null;

  const requestedScale = requiredNearDepth / robustNearDepth;
  const scale = Math.min(
    Math.max(requestedScale, LOOKING_GLASS_SOURCE_DEPTH_SCALE_RANGE.min),
    LOOKING_GLASS_SOURCE_DEPTH_SCALE_RANGE.max
  );
  if (Math.abs(scale - safeCurrentScale) <= 1e-6) return null;
  return {
    scale,
    scaleFactor: scale / safeCurrentScale,
    currentNearDepth,
    requiredNearDepth,
    limited: Math.abs(scale - requestedScale) > 1e-6,
  };
}

/**
 * Normalize a fixed-source reconstruction only when ordinary quilt-baseline
 * convergence cannot reach it. Scaling XYZ uniformly around the source-camera
 * apex preserves every central-view ray and therefore keeps the fitted source
 * border straight; unlike a rigid Z translation it does not alter projection.
 */
export function getLookingGlassSourceDepthScaleRebase({
  sourceOriginZ,
  cameraCenterZ,
  configuredTargetZ,
  robustNearBoundaryZ,
  crowdedBoundaryZ,
  currentScale,
  targetDiameter,
  baselineScaleMin = 0.25,
  baselineScaleMax = 2,
}: LookingGlassSourceDepthScaleRebaseInput): LookingGlassSourceDepthScaleRebase | null {
  if (
    !Number.isFinite(sourceOriginZ) ||
    !Number.isFinite(cameraCenterZ) ||
    !Number.isFinite(configuredTargetZ) ||
    !Number.isFinite(robustNearBoundaryZ) ||
    !Number.isFinite(crowdedBoundaryZ)
  ) {
    return null;
  }

  const configuredDistance = cameraCenterZ - configuredTargetZ;
  if (configuredDistance <= 0.05) return null;

  const minimumBaseline = Number.isFinite(baselineScaleMin)
    ? Math.max(baselineScaleMin, 0.01)
    : 0.25;
  const maximumBaseline = Number.isFinite(baselineScaleMax)
    ? Math.max(baselineScaleMax, minimumBaseline)
    : 2;
  const farReachableTargetZ =
    cameraCenterZ - maximumBaseline * configuredDistance;
  const nearReachableTargetZ =
    cameraCenterZ - minimumBaseline * configuredDistance;
  const diameter = Number.isFinite(targetDiameter)
    ? Math.max(Math.abs(targetDiameter), 0.1)
    : 1;
  const deadband = Math.max(0.02, diameter * 0.01);

  let boundaryZ: number;
  let reason: LookingGlassSourceDepthRebaseReason;
  if (robustNearBoundaryZ < farReachableTargetZ - deadband) {
    boundaryZ = robustNearBoundaryZ;
    reason = 'all-behind';
  } else if (crowdedBoundaryZ > nearReachableTargetZ + deadband) {
    boundaryZ = crowdedBoundaryZ;
    reason = 'crowded-front';
  } else {
    return null;
  }

  const boundaryOffset = boundaryZ - sourceOriginZ;
  const targetOffset = configuredTargetZ - sourceOriginZ;
  if (Math.abs(boundaryOffset) <= Number.EPSILON) return null;
  const scaleFactor = targetOffset / boundaryOffset;
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return null;

  const safeCurrentScale = Number.isFinite(currentScale) && currentScale > 0
    ? currentScale
    : 1;
  const requestedScale = safeCurrentScale * scaleFactor;
  const scale = Math.min(
    Math.max(requestedScale, LOOKING_GLASS_SOURCE_DEPTH_SCALE_RANGE.min),
    LOOKING_GLASS_SOURCE_DEPTH_SCALE_RANGE.max
  );
  if (Math.abs(scale - safeCurrentScale) <= 1e-6) return null;

  return {
    scale,
    scaleFactor: scale / safeCurrentScale,
    reason,
    limited: Math.abs(scale - requestedScale) > 1e-6,
    farReachableTargetZ,
    nearReachableTargetZ,
  };
}

interface LookingGlassAutoConvergenceClassificationInput {
  frontBoundaryZ: number;
  crowdedBoundaryZ: number;
  currentTargetZ: number;
  previousFrontBoundaryZ: number | null;
  targetDiameter: number;
}

/** Detect a real depth-boundary jump independently from the current target. */
export function isLookingGlassAutoConvergenceSceneChange(
  frontBoundaryZ: number,
  previousFrontBoundaryZ: number | null,
  targetDiameter: number
): boolean {
  if (
    !Number.isFinite(frontBoundaryZ) ||
    previousFrontBoundaryZ === null ||
    !Number.isFinite(previousFrontBoundaryZ)
  ) {
    return false;
  }
  const diameter = Number.isFinite(targetDiameter)
    ? Math.max(Math.abs(targetDiameter), 0.1)
    : 1;
  const sceneChangeThreshold = Math.max(0.25, diameter * 0.15);
  return (
    Math.abs(frontBoundaryZ - previousFrontBoundaryZ) >
    sceneChangeThreshold
  );
}

/**
 * Decide whether a Looking Glass convergence update may skip manual hold and
 * temporal confirmation. World +Z is toward the viewer in this render path.
 * The 10% boundary ignores a small foreground corner; the 20% boundary marks
 * a genuinely crowded protruding region.
 */
export function classifyLookingGlassAutoConvergence({
  frontBoundaryZ,
  crowdedBoundaryZ,
  currentTargetZ,
  previousFrontBoundaryZ,
  targetDiameter,
}: LookingGlassAutoConvergenceClassificationInput): LookingGlassAutoConvergenceUrgency {
  if (
    !Number.isFinite(frontBoundaryZ) ||
    !Number.isFinite(crowdedBoundaryZ) ||
    !Number.isFinite(currentTargetZ)
  ) {
    return 'normal';
  }
  const diameter = Number.isFinite(targetDiameter)
    ? Math.max(Math.abs(targetDiameter), 0.1)
    : 1;
  const placementDeadband = Math.max(0.02, diameter * 0.01);

  // Placement safety takes priority over the generic scene-change label. A
  // close cut commonly satisfies both, but it must use the non-animated
  // foreground recovery path instead of waiting for the fast easing path.
  if (crowdedBoundaryZ > currentTargetZ + placementDeadband) {
    return 'crowded-front';
  }
  if (frontBoundaryZ < currentTargetZ - placementDeadband) {
    return 'all-behind';
  }
  if (isLookingGlassAutoConvergenceSceneChange(
    frontBoundaryZ,
    previousFrontBoundaryZ,
    targetDiameter
  )) {
    return 'scene-change';
  }
  return 'normal';
}

export function getLookingGlassRequiredPushback(
  nearSurfaceWorldZ: number,
  targetZ: number,
  targetDiameter: number,
  maxFrontFraction = LOOKING_GLASS_MAX_FRONT_FRACTION
): number {
  if (
    !Number.isFinite(nearSurfaceWorldZ) ||
    !Number.isFinite(targetZ) ||
    !Number.isFinite(targetDiameter)
  ) {
    return 0;
  }
  const allowedFront = Math.max(targetDiameter, 0) * Math.max(maxFrontFraction, 0);
  return Math.max(0, nearSurfaceWorldZ - targetZ - allowedFront);
}

export function getWebXRRequiredPushback(
  nearDepth: number,
  minimumDistance = WEBXR_MIN_INITIAL_EYE_DISTANCE
): number {
  if (!Number.isFinite(nearDepth) || !Number.isFinite(minimumDistance)) return 0;
  return Math.max(0, minimumDistance - Math.max(nearDepth, 0));
}

/**
 * Bidirectional, temporally robust zero-parallax target for Looking Glass.
 * It never changes mesh/camera placement; RawXR consumes it as a view-baseline
 * scale. A three-sample median rejects a transient foreground/far outlier.
 */
export class AutoConvergenceController {
  private current: number | null = null;
  private target: number | null = null;
  private history: number[] = [];

  reset(initialTarget?: number): void {
    const initial = Number.isFinite(initialTarget)
      ? (initialTarget as number)
      : null;
    this.current = initial;
    this.target = initial;
    this.history = [];
  }

  observe(
    desiredTarget: number,
    targetDiameter: number,
    historyLength = LOOKING_GLASS_AUTO_CONVERGENCE_HISTORY
  ): void {
    if (!Number.isFinite(desiredTarget)) return;
    if (this.current === null || this.target === null) {
      this.current = desiredTarget;
      this.target = desiredTarget;
      return;
    }

    const windowLength = Math.max(1, Math.floor(historyLength));
    this.history.push(desiredTarget);
    if (this.history.length > windowLength) this.history.shift();
    if (this.history.length < windowLength) return;

    const sorted = [...this.history].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const diameter = Number.isFinite(targetDiameter)
      ? Math.max(Math.abs(targetDiameter), 0.1)
      : 1;
    const deadband = Math.max(0.02, diameter * 0.01);
    if (Math.abs(median - this.target) <= deadband) return;

    const maxStep = Math.max(0.05, diameter * 0.1);
    this.target += Math.min(
      Math.max(median - this.target, -maxStep),
      maxStep
    );
    this.history = [];
  }

  /** Skip history for a cut or clearly invalid placement, but still animate. */
  observeImmediate(desiredTarget: number): void {
    if (!Number.isFinite(desiredTarget)) return;
    if (this.current === null) this.current = desiredTarget;
    this.target = desiredTarget;
    this.history = [];
  }

  /** Apply a spatially robust foreground-safety correction this frame. */
  snap(desiredTarget: number): void {
    if (!Number.isFinite(desiredTarget)) return;
    this.current = desiredTarget;
    this.target = desiredTarget;
    this.history = [];
  }

  advance(deltaSeconds: number, responseRate = 2): number | null {
    if (this.current === null || this.target === null) return this.current;
    const dt = Math.min(Math.max(deltaSeconds, 0), 0.25);
    const alpha = 1 - Math.exp(-Math.max(responseRate, 0) * dt);
    this.current += (this.target - this.current) * alpha;
    if (Math.abs(this.target - this.current) < 1e-4) {
      this.current = this.target;
    }
    return this.current;
  }

  get value(): number | null {
    return this.current;
  }

  get targetValue(): number | null {
    return this.target;
  }
}

/**
 * Holds the greatest required rigid pushback for one presentation. The first
 * observation is applied before the first useful frame; later increases are
 * damped and the scene is never pulled forward again, avoiding depth pumping.
 */
export class FrontSafetyController {
  private current = 0;
  private target = 0;
  private initialized = false;
  private pendingIncreases: number[] = [];

  reset(): void {
    this.current = 0;
    this.target = 0;
    this.initialized = false;
    this.pendingIncreases = [];
  }

  observe(requiredPushback: number, confirmationSamples = 1): void {
    if (!Number.isFinite(requiredPushback)) return;
    const required = Math.max(requiredPushback, 0);
    if (!this.initialized) {
      this.target = required;
      this.current = this.target;
      this.initialized = true;
      return;
    }
    if (required <= this.target) {
      this.pendingIncreases = [];
      return;
    }

    const confirmation = Math.max(1, Math.floor(confirmationSamples));
    if (confirmation === 1) {
      this.target = required;
      this.pendingIncreases = [];
      return;
    }

    this.pendingIncreases.push(required);
    if (this.pendingIncreases.length < confirmation) return;

    // Raise only to the amount supported by every recent sample. A one-frame
    // depth failure therefore cannot permanently ratchet the hologram back.
    const confirmed = Math.min(...this.pendingIncreases);
    this.target = Math.max(this.target, confirmed);
    this.pendingIncreases = [];
  }

  get pendingIncreaseCount(): number {
    return this.pendingIncreases.length;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  advance(deltaSeconds: number, responseRate = 6): number {
    if (!this.initialized || this.current >= this.target) return this.current;
    const dt = Math.min(Math.max(deltaSeconds, 0), 0.25);
    const rate = Math.max(responseRate, 0);
    const remaining = this.target - this.current;
    this.current = this.target - remaining * Math.exp(-rate * dt);
    if (this.target - this.current < 1e-4) this.current = this.target;
    return this.current;
  }

  get value(): number {
    return this.current;
  }

  get targetValue(): number {
    return this.target;
  }
}
