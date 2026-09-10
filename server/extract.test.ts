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
      folders: [],
      mode: 'limited',
      source: 'google',
    });
  });

  it('accepts a Takeout folder without individual ZIP ids', () => {
    expect(
      parseExtractRequest({
        folders: [{ id: 'folder-1', name: 'Takeout' }],
        source: 'google',
      }),
    ).toEqual({
      files: [],
      folders: [{ id: 'folder-1', name: 'Takeout' }],
      mode: 'full',
      source: 'google',
    });
  });

  it('rejects missing or unsafe file ids', () => {
    expect(() => parseExtractRequest({ files: [] })).toThrow(/Takeout folder/i);
    expect(() => parseExtractRequest({ files: [{ id: '../etc', name: 'a.zip' }] })).toThrow(
      /not valid/i,
    );
  });
});
