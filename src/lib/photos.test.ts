import { describe, expect, it } from 'vitest';
import { parseGoogleDuration } from './photos';

describe('Google Photos picker client helpers', () => {
  it('parses poll intervals from Google duration strings', () => {
    expect(parseGoogleDuration('5s', 1000)).toBe(5000);
    expect(parseGoogleDuration(undefined, 4000)).toBe(4000);
  });
});
