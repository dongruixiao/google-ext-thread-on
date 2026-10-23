import { describe, expect, it } from 'vitest';
import { buildAncestorPath } from './path';

const LEVELS = [1, 2, 3, 4];

describe('buildAncestorPath', () => {
  it('excludes the article title and current section by default', () => {
    expect(buildAncestorPath([0, 1, 2], LEVELS)).toEqual([1]);
    expect(buildAncestorPath([0, 1, 2, 3], LEVELS)).toEqual([1, 2]);
  });

  it('keeps the article title when requested', () => {
    expect(buildAncestorPath([0, 1, 2], LEVELS, false)).toEqual([0, 1]);
  });

  it('keeps a non-h1 root ancestor', () => {
    expect(buildAncestorPath([0, 1, 2], [2, 3, 4])).toEqual([0, 1]);
  });

  it('returns an empty list when there are no visible ancestors', () => {
    expect(buildAncestorPath([], LEVELS)).toEqual([]);
    expect(buildAncestorPath([0], LEVELS)).toEqual([]);
    expect(buildAncestorPath([0, 1], LEVELS)).toEqual([]);
  });
});
