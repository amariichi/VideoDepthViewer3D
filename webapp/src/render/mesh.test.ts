import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { createGridGeometry } from './mesh';

describe('continuous depth mesh', () => {
  it('keeps every grid triangle connected and static', () => {
    const geometry = createGridGeometry({ aspect: 16 / 9, targetTriangles: 20_000 });
    const index = geometry.index;

    expect(index).not.toBeNull();
    if (!index) throw new Error('Plane geometry did not create an index buffer');
    expect(index.usage).toBe(THREE.StaticDrawUsage);

    let degenerateTriangles = 0;
    for (let offset = 0; offset < index.count; offset += 3) {
      const a = index.getX(offset);
      const b = index.getX(offset + 1);
      const c = index.getX(offset + 2);
      if (a === b || b === c || a === c) degenerateTriangles += 1;
    }

    expect(index.count).toBeGreaterThan(0);
    expect(degenerateTriangles).toBe(0);
  });
});
