import { describe, expect, it } from 'vitest';
import { getModeTargetTriangles } from './qualityPolicy';

describe('frontend quality policy', () => {
  it('uses distinct topology budgets for automatic modes', () => {
    expect(getModeTargetTriangles('smooth', 200_000)).toBe(60_000);
    expect(getModeTargetTriangles('balanced', 200_000)).toBe(140_000);
    expect(getModeTargetTriangles('quality', 200_000)).toBe(240_000);
    expect(getModeTargetTriangles('manual', 175_000)).toBe(175_000);
  });

  it('never creates more triangles than the transported depth grid supports', () => {
    expect(getModeTargetTriangles('quality', 200_000, 160, 90)).toBe(
      2 * 159 * 89
    );
  });
});
