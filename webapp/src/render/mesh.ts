import * as THREE from 'three';

export interface MeshConfig {
  aspect: number;
  targetTriangles: number;
}

export function createGridGeometry({ aspect, targetTriangles }: MeshConfig): THREE.BufferGeometry {
  const epsilon = Math.max(targetTriangles, 10);
  const nxFloat = Math.sqrt((epsilon * Math.max(aspect, 0.1)) / 2);
  const nyFloat = Math.sqrt(epsilon / (2 * Math.max(aspect, 0.1)));
  let segmentsX = Math.max(2, Math.round(nxFloat));
  let segmentsY = Math.max(2, Math.round(nyFloat));
  if (aspect < 1 && segmentsY > 1024) {
    const stride = Math.ceil(segmentsY / 1024);
    segmentsY = Math.max(2, Math.floor(segmentsY / stride));
  }
  const geometry = new THREE.PlaneGeometry(1, 1, segmentsX, segmentsY);
  geometry.computeVertexNormals();
  return geometry;
}
