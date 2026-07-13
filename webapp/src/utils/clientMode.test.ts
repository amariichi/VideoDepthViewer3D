import { describe, expect, it } from 'vitest';

import { resolveClientMode } from './clientMode';

describe('client mode detection', () => {
  it('honors explicit query overrides', () => {
    expect(resolveClientMode({ search: '?mode=remote', userAgent: '' })).toBe('remote');
    expect(
      resolveClientMode({
        search: '?mode=viewer',
        userAgent: 'Mozilla/5.0 (iPhone)',
      })
    ).toBe('viewer');
  });

  it('selects remote mode for iPhone, Android, and desktop-identity iPad', () => {
    expect(
      resolveClientMode({ search: '', userAgent: 'Mozilla/5.0 (iPhone)' })
    ).toBe('remote');
    expect(
      resolveClientMode({ search: '', userAgent: 'Mozilla/5.0 (Linux; Android 16)' })
    ).toBe('remote');
    expect(
      resolveClientMode({
        search: '',
        userAgent: 'Mozilla/5.0 (Macintosh)',
        platform: 'MacIntel',
        maxTouchPoints: 5,
      })
    ).toBe('remote');
  });

  it('keeps desktop browsers in viewer mode regardless of window width', () => {
    expect(
      resolveClientMode({
        search: '',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
        platform: 'Linux x86_64',
        maxTouchPoints: 0,
      })
    ).toBe('viewer');
  });
});
