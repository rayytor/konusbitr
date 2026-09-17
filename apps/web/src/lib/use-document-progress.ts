'use client';

import {
  type DocumentStatus,
  type DocumentView,
  isTerminalDocumentStatus,
  type JobStage,
} from '@konusbitr/shared';
import { useEffect, useRef, useState } from 'react';

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
  /** How much of the document has been read, once the worker knows. */
  pagesReady?: number | null;
  pagesTotal?: number | null;
  /**
   * Seconds left, estimated from how fast pages have actually been arriving.
   *
   * Absent until there is enough to estimate from, and absent again the moment
   * the document finishes. A number here is a promise, and a wrong one on a
   * screen somebody is waiting at is worse than no number — so it is computed
   * from observed throughput rather than from a constant, and it is not shown
   * at all on documents whose page count is unknown.
   */
  etaSeconds?: number;
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

/**
 * How many page observations the rolling average is taken over.
 *
 * Long enough that one slow scanned page does not double the estimate, short
 * enough that a filing which switches from born-digital pages to photocopies
 * halfway through is re-estimated rather than remembered. Six batches is a
 * couple of minutes of a long ingest.
 */
const ETA_WINDOW = 6;

/** Below this many pages there is nothing to estimate from; the number would be noise. */
const ETA_MIN_PAGES = 4;

type Sample = { at: number; pages: number };

export function useDocumentProgress(
  documents: DocumentView[],
): Record<string, DocumentProgress | undefined> {
  const [progress, setProgress] = useState<Record<string, DocumentProgress | undefined>>({});

  // Kept in a ref rather than in state: a new sample changes the estimate, not
  // the render, and putting the history in state would re-render every watched
  // row on every frame of every other row.
  const samples = useRef<Map<string, Sample[]>>(new Map());

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
          const etaSeconds = estimate(samples.current, documentId, frame);
          setProgress((current) => ({
            ...current,
            [documentId]: etaSeconds === undefined ? frame : { ...frame, etaSeconds },
          }));
        } catch {
          // A frame we cannot read is not worth breaking the page over.
        }
      });

      // The server closes after a terminal stage. Closing from this side too
      // stops `EventSource` from reconnecting to a stream that is finished.
      source.addEventListener('done', () => {
        samples.current.delete(documentId);
        source.close();
      });

      return source;
    });

    return () => {
      for (const source of sources) source.close();
    };
  }, [key]);

  return progress;
}

/**
 * Seconds remaining, from the rate pages have actually been arriving at.
 *
 * A rolling average over the last few observations rather than the whole run,
 * because the rate genuinely changes: a filing whose first two hundred pages
 * are born-digital and whose last fifty are photocopies goes ten times slower
 * at the end, and an average over the whole document would promise the reader
 * a finish time it will miss by minutes.
 *
 * Returns `undefined` rather than a guess in every case where a guess would be
 * dishonest — no page count, no movement yet, or a rate of zero.
 */
function estimate(
  history: Map<string, Sample[]>,
  documentId: string,
  frame: DocumentProgress,
): number | undefined {
  const done = frame.pagesReady ?? 0;
  const total = frame.pagesTotal ?? 0;
  if (!total || done <= 0 || done >= total) {
    if (done >= total) history.delete(documentId);
    return undefined;
  }

  const samples = history.get(documentId) ?? [];
  const last = samples.at(-1);
  // Only a frame that actually moved the counter is an observation. Stage
  // frames arrive in between and would otherwise be recorded as "zero pages in
  // no time", which pulls the average towards nonsense.
  if (last === undefined || last.pages < done) {
    samples.push({ at: Date.now(), pages: done });
    history.set(documentId, samples.slice(-ETA_WINDOW));
  }

  const window = history.get(documentId) ?? [];
  const first = window[0];
  const latest = window.at(-1);
  if (!first || !latest || latest === first) return undefined;

  const pages = latest.pages - first.pages;
  const seconds = (latest.at - first.at) / 1000;
  if (pages < ETA_MIN_PAGES || seconds <= 0) return undefined;

  return Math.round(((total - done) * seconds) / pages);
}

/**
 * An estimate rendered the way a person reads a wait.
 *
 * Deliberately coarse. A countdown to the second invites somebody to watch it
 * and notice every time it is wrong, and the underlying number is a rolling
 * average of a rate that changes — so it is rounded to something that stays
 * true for as long as it is on screen.
 */
export function formatEta(seconds: number): string {
  if (seconds < 45) return 'less than a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(seconds / 3600);
  return `about ${hours} hour${hours === 1 ? '' : 's'}`;
}
