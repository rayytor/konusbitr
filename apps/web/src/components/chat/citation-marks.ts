import type { Element, Root, RootContent, Text } from 'hast';

/**
 * Turn `[[chunk_id, page]]` markers in an answer into elements.
 *
 * Phase 10's verifier strips the trailing `<citations>` block but deliberately
 * leaves the inline markers in the answer text, because they are the only
 * record of *where in the sentence* each claim was made. That is exactly what
 * the UI needs — a chip after the clause it supports rather than a pile of
 * references at the bottom — and it is why this is a rehype plugin rather than
 * a regex over the rendered string: by the time markdown has become HTML, the
 * markers are spread across text nodes inside paragraphs, list items and table
 * cells, and only a tree walk finds all of them without touching code blocks.
 *
 * Code blocks are the reason for the `skip` set. A document about this product
 * could quote a citation marker inside a fenced block, and rewriting it there
 * would silently corrupt the code the reader is trying to read.
 */

const MARKER = /\[\[([a-zA-Z0-9_-]+),\s*(?:p\.?\s*)?(\d+)\]\]/g;

const SKIP = new Set(['code', 'pre']);

export function rehypeCitationMarks() {
  return (tree: Root) => {
    walk(tree, false);
  };
}

function walk(node: Root | Element, insideCode: boolean): void {
  const children: RootContent[] = [];
  let changed = false;

  for (const child of node.children) {
    if (child.type === 'element') {
      walk(child, insideCode || SKIP.has(child.tagName));
      children.push(child);
      continue;
    }

    if (child.type !== 'text' || insideCode) {
      children.push(child);
      continue;
    }

    const split = splitText(child);
    if (split === null) {
      children.push(child);
      continue;
    }

    changed = true;
    children.push(...split);
  }

  if (changed) node.children = children;
}

function splitText(node: Text): RootContent[] | null {
  MARKER.lastIndex = 0;
  if (!MARKER.test(node.value)) return null;

  MARKER.lastIndex = 0;
  const out: RootContent[] = [];
  let cursor = 0;

  for (const match of node.value.matchAll(MARKER)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      out.push({ type: 'text', value: node.value.slice(cursor, index) });
    }
    out.push({
      type: 'element',
      tagName: 'span',
      properties: {
        dataCitationChunk: match[1],
        dataCitationPage: match[2],
      },
      children: [],
    });
    cursor = index + match[0].length;
  }

  if (cursor < node.value.length) {
    out.push({ type: 'text', value: node.value.slice(cursor) });
  }

  return out;
}
