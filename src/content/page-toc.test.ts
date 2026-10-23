import { beforeEach, describe, expect, it } from 'vitest';
import type { HeadingNode } from './extractor';
import { findTocCandidates } from './page-toc';

function heading(id: string): HeadingNode {
  const element = document.createElement('h2');
  element.id = id;
  return {
    id,
    element,
    level: 2,
    text: id,
    parentIndex: -1,
  };
}

describe('findTocCandidates', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('skips malformed URL fragments without aborting TOC detection', () => {
    document.body.innerHTML = `
      <nav aria-label="On this page">
        <a href="#s1">One</a>
        <a href="#s2">Two</a>
        <a href="#bad%">Broken</a>
        <a href="#s3">Three</a>
      </nav>
      <article>
        <h2 id="s1">One</h2>
        <h2 id="s2">Two</h2>
        <h2 id="s3">Three</h2>
      </article>
    `;

    const candidates = findTocCandidates([
      heading('s1'),
      heading('s2'),
      heading('s3'),
    ]);

    expect(candidates.map((element) => element.tagName)).toEqual(['NAV']);
  });
});
