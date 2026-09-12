'use client';

import {
  type DocumentStatus,
  type DocumentView,
  isTerminalDocumentStatus,
  type JobStage,
} from '@konusbitr/shared';
import { useEffect, useState } from 'react';

/**
 * Watch every unfinished document in a list, over SSE.
 *
 * The server replays the current state as its first frame, so a page that is
 * refreshed mid-parse shows the right stage immediately rather than waiting
 * for the next stage boundary — which matters most for OCR, where boundaries
 * can be a minute apart.
 *
 * `EventSource` reconnects on its own after a dropped connection, and each
 * reconnect replays. That is the whole resilience story, and it is why this
 * uses the browser's own primitive rather than a `fetch` stream reader.
 */

export type DocumentProgress = {
  stage: JobStage;
  percent: number;
  message?: string;
};

/**
 * At most this many streams at once.
 *
 * A browser allows about six concurrent connections per origin over HTTP/1.1,
 * and an SSE stream holds one open for as long as it lives. Watching a library
 * of twenty queued documents would use the budget up and leave the page unable
 * to load anything else — so the oldest-listed few are watched and the rest
 * are picked up as those finish.
 */
const MAX_STREAMS = 4;

export function useDocumentProgress(
  documents: DocumentView[],
): Record<string, DocumentProgress | undefined> {
  const [progress, setProgress] = useState<Record<string, DocumentProgress | undefined>>({});

  // A stable key, so the effect re-runs when the *set* of unfinished documents
  // changes and not on every re-render of the same set.
  const watching = documents
    .filter((document) => !isTerminalDocumentStatus(document.status as DocumentStatus))
    .slice(0, MAX_STREAMS)
    .map((document) => document.id);
  const key = watching.join(',');

  useEffect(() => {
    if (key === '') return;

    const sources = key.split(',').map((documentId) => {
      const source = new EventSource(`/api/documents/${documentId}/events`);

      source.addEventListener('progress', (event) => {
        try {
          const frame = JSON.parse((event as MessageEvent<string>).data) as DocumentProgress;
          setProgress((current) => ({ ...current, [documentId]: frame }));
        } catch {
          // A frame we cannot read is not worth breaking the page over.
        }
      });

      // The server closes after a terminal stage. Closing from this side too
      // stops `EventSource` from reconnecting to a stream that is finished.
      source.addEventListener('done', () => source.close());

      return source;
    });

    return () => {
      for (const source of sources) source.close();
    };
  }, [key]);

  return progress;
}
