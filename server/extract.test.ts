import { describe, expect, it } from 'vitest';
import { parseExtractRequest } from './extract';

describe('extract request parsing', () => {
  it('accepts Drive ZIP ids and normalizes options', () => {
    expect(
      parseExtractRequest({
        files: [{ id: 'abc-123', name: 'Takeout/Photos' }],
        mode: 'limited',
        source: 'google',
      }),
    ).toEqual({
      files: [{ id: 'abc-123', name: 'Photos.zip' }],
      mode: 'limited',
      source: 'google',
    });
  });

  it('rejects missing or unsafe file ids', () => {
    expect(() => parseExtractRequest({ files: [] })).toThrow(/at least one/i);
    expect(() => parseExtractRequest({ files: [{ id: '../etc', name: 'a.zip' }] })).toThrow(
      /not valid/i,
    );
  });
});
