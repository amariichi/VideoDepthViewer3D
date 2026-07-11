import * as THREE from 'three';

export interface MeshConfig {
  aspect: number;
  targetTriangles: number;
}

export interface GridSegments {
  segmentsX: number;
  segmentsY: number;
}

export function getGridSegments({
  aspect,
  targetTriangles,
}: MeshConfig): GridSegments {
  const epsilon = Math.max(targetTriangles, 10);
  const nxFloat = Math.sqrt((epsilon * Math.max(aspect, 0.1)) / 2);
  const nyFloat = Math.sqrt(epsilon / (2 * Math.max(aspect, 0.1)));
  const segmentsX = Math.max(2, Math.round(nxFloat));
  let segmentsY = Math.max(2, Math.round(nyFloat));
  if (aspect < 1 && segmentsY > 1024) {
    const stride = Math.ceil(segmentsY / 1024);
    segmentsY = Math.max(2, Math.floor(segmentsY / stride));
  }
  return { segmentsX, segmentsY };
}

export function createGridGeometry({ aspect, targetTriangles }: MeshConfig): THREE.BufferGeometry {
  const { segmentsX, segmentsY } = getGridSegments({
    aspect,
    targetTriangles,
  });
  // Keep the full grid connected. Cutting depth-discontinuity triangles creates
  // high-contrast cracks under oblique or multi-view rendering.
  const geometry = new THREE.PlaneGeometry(1, 1, segmentsX, segmentsY);
  geometry.computeVertexNormals();
  return geometry;
}
