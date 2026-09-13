import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type RetrievedChunk, retrieve } from '@konusbitr/retrieval';
import { buildEvalChunks, EVALS_DIR, loadFixtureCorpus } from './corpus.js';
import { type EvalHarness, startEvalHarness } from './harness.js';

const GOLDEN_FILE = join(EVALS_DIR, 'golden', 'corpus.jsonl');
const RESULTS_FILE = join(EVALS_DIR, 'RESULTS.md');

export type GoldenItem = {
  question: string;
  documentId: string;
  expectedPages: number[];
  answer: string;
};

export type EvalMetrics = {
  recallAt8: number;
  mrr: number;
  contextPrecision: number;
  totalQuestions: number;
};

/**
 * What a healthy pipeline scores on this corpus, recorded so a change that
 * quietly makes retrieval worse fails rather than simply printing a smaller
 * number. Update these deliberately, in the same commit as the improvement that
 * earns it — never to make a red build go green.
 */
export const BASELINE = {
  documentRecallAt8: 100.0,
  documentMrr: 0.9894,
  corpusRecallAt8: 95.61,
} as const;

export const REGRESSION_THRESHOLD_POINTS = 2.0;

export function loadGoldenSet(file: string = GOLDEN_FILE): GoldenItem[] {
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as GoldenItem);
}

/**
 * Score one ranked result list against one golden item.
 *
 * A chunk counts as relevant when it comes from the expected document *and*
 * touches one of the expected pages — the page is not decoration, it is what a
 * citation points at, so a passage retrieved from the wrong page is a miss even
 * when its text is right.
 */
export function scoreOne(
  item: GoldenItem,
  chunks: readonly RetrievedChunk[],
): { hit: boolean; reciprocalRank: number; averagePrecision: number } {
  const expected = new Set(item.expectedPages);
  let firstHitRank = 0;
  let relevant = 0;
  let precisionSum = 0;

  chunks.slice(0, 8).forEach((chunk, index) => {
    const rank = index + 1;
    const isHit =
      chunk.documentId === item.documentId && chunk.pages.some((page) => expected.has(page.page));
    if (isHit) {
      relevant++;
      precisionSum += relevant / rank;
      if (firstHitRank === 0) {
        firstHitRank = rank;
      }
    }
  });

  return {
    hit: relevant > 0,
    reciprocalRank: firstHitRank === 0 ? 0 : 1 / firstHitRank,
    averagePrecision: relevant === 0 ? 0 : precisionSum / relevant,
  };
}

export function aggregate(
  scores: readonly { hit: boolean; reciprocalRank: number; averagePrecision: number }[],
): EvalMetrics {
  const total = scores.length;
  if (total === 0) {
    return { recallAt8: 0, mrr: 0, contextPrecision: 0, totalQuestions: 0 };
  }
  return {
    recallAt8: (scores.filter((score) => score.hit).length / total) * 100,
    mrr: scores.reduce((sum, score) => sum + score.reciprocalRank, 0) / total,
    contextPrecision: scores.reduce((sum, score) => sum + score.averagePrecision, 0) / total,
    totalQuestions: total,
  };
}

/**
 * Run every golden question through the real `retrieve()`.
 *
 * `legs` is the ablation: `['dense']` measures vector search alone, both legs
 * measure the hybrid pipeline. Same function, same SQL, same fusion — only the
 * legs differ, which is what makes the comparison mean anything.
 *
 * `scope` matters as much. In **document** scope the question is "given the
 * right document, does retrieval find the right page?", which is what recall@8
 * and MRR were defined for. In **corpus** scope it also has to find the right
 * document, against four others that repeat the same body passage — see
 * `evals/RESULTS.md` for why that makes some questions in this corpus genuinely
 * unanswerable rather than merely hard.
 */
export async function measure(
  harness: EvalHarness,
  golden: readonly GoldenItem[],
  legs: readonly ('dense' | 'sparse')[],
  scopeKind: 'document' | 'corpus',
): Promise<EvalMetrics> {
  const scores = [];
  for (const item of golden) {
    const chunks = await retrieve({
      db: harness.db,
      env: harness.env,
      embed: harness.embed,
      orgId: harness.orgId,
      scope:
        scopeKind === 'document'
          ? { kind: 'document', documentId: item.documentId }
          : { kind: 'corpus' },
      query: item.question,
      topK: 8,
      legs,
      onLegError: (leg, error) => {
        throw new Error(`the ${leg} leg failed during evaluation: ${String(error)}`);
      },
    });
    scores.push(scoreOne(item, chunks));
  }
  return aggregate(scores);
}

/** Every metric for one scope: each leg alone, and the two fused. */
export type ScopeResults = {
  dense: EvalMetrics;
  sparse: EvalMetrics;
  hybrid: EvalMetrics;
};

export type EvalRun = {
  document: ScopeResults;
  corpus: ScopeResults;
  chunkCount: number;
  questions: number;
};

async function measureScope(
  harness: EvalHarness,
  golden: readonly GoldenItem[],
  scopeKind: 'document' | 'corpus',
): Promise<ScopeResults> {
  return {
    dense: await measure(harness, golden, ['dense'], scopeKind),
    sparse: await measure(harness, golden, ['sparse'], scopeKind),
    hybrid: await measure(harness, golden, ['dense', 'sparse'], scopeKind),
  };
}

function printScope(title: string, results: ScopeResults): void {
  const line = (
    label: string,
    pick: (metrics: EvalMetrics) => number,
    digits: number,
    suffix = '',
  ) => {
    const dense = pick(results.dense);
    const sparse = pick(results.sparse);
    const hybrid = pick(results.hybrid);
    const delta = hybrid - dense;
    return `${label.padEnd(18)} ${dense.toFixed(digits).padStart(8)}${suffix} ${sparse.toFixed(digits).padStart(8)}${suffix} ${hybrid.toFixed(digits).padStart(8)}${suffix}   ${delta >= 0 ? '+' : ''}${delta.toFixed(digits)}${suffix}`;
  };

  console.log(`\n${title}`);
  console.log('-'.repeat(70));
  console.log(
    `${'Metric'.padEnd(18)} ${'Dense'.padStart(9)} ${'Sparse'.padStart(8)} ${'Hybrid'.padStart(9)}   vs dense`,
  );
  console.log(line('Recall@8', (m) => m.recallAt8, 2, '%'));
  console.log(line('MRR', (m) => m.mrr, 4));
  console.log(line('Context precision', (m) => m.contextPrecision, 4));
}

export async function runEval(
  options: { brokenChunker?: boolean; write?: boolean } = {},
): Promise<EvalRun> {
  const golden = loadGoldenSet();
  console.log(`Loaded ${golden.length} question/answer pairs from ${GOLDEN_FILE}`);

  if (options.brokenChunker) {
    console.log(
      '[chunker] shredded mode: fixed-width windows, provenance smeared across page breaks',
    );
  }

  console.log('Starting Postgres and indexing the fixture corpus…');
  const chunks = buildEvalChunks(loadFixtureCorpus(), options.brokenChunker ? 'shredded' : 'page');
  const harness = await startEvalHarness({ chunks });
  console.log(`Indexed ${harness.chunks.length} chunks across the fixture corpus.`);

  try {
    const run: EvalRun = {
      document: await measureScope(harness, golden, 'document'),
      corpus: await measureScope(harness, golden, 'corpus'),
      chunkCount: harness.chunks.length,
      questions: golden.length,
    };

    console.log('\n======================================================================');
    console.log('                     RETRIEVAL EVALUATION RESULTS                      ');
    console.log('======================================================================');
    printScope('Document scope — find the right page in a known document', run.document);
    printScope('Corpus scope — find the right document, then the right page', run.corpus);
    console.log('');

    if (options.write && !options.brokenChunker) {
      writeResults(run);
      console.log(`Baseline written to ${RESULTS_FILE}\n`);
    }

    assertGates(run);
    return run;
  } finally {
    await harness.stop();
  }
}

/**
 * The gates, and why they are pointed where they are.
 *
 * Document-scope recall@8 saturates at 100% on this corpus — every fixture is
 * small enough that eight chunks reach the right page — so it is a smoke alarm
 * rather than a quality signal, and it is gated as one. The metrics that
 * actually move here are document-scope MRR and corpus-scope recall@8, and those
 * carry the 2-point margin the phase asks for.
 */
export function assertGates(run: EvalRun): void {
  const failures: string[] = [];

  if (run.document.hybrid.mrr <= run.document.dense.mrr) {
    failures.push(
      `hybrid did not beat dense-only on document-scope MRR (${run.document.hybrid.mrr.toFixed(4)} vs ${run.document.dense.mrr.toFixed(4)})`,
    );
  }

  const checks: [string, number, number][] = [
    ['document-scope recall@8', run.document.hybrid.recallAt8, BASELINE.documentRecallAt8],
    ['corpus-scope recall@8', run.corpus.hybrid.recallAt8, BASELINE.corpusRecallAt8],
    ['document-scope MRR (×100)', run.document.hybrid.mrr * 100, BASELINE.documentMrr * 100],
  ];

  for (const [label, actual, baseline] of checks) {
    const drop = baseline - actual;
    if (drop > REGRESSION_THRESHOLD_POINTS) {
      failures.push(
        `${label} fell ${drop.toFixed(2)} points below its ${baseline.toFixed(2)} baseline (now ${actual.toFixed(2)}), past the ${REGRESSION_THRESHOLD_POINTS.toFixed(1)}-point margin`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(`retrieval regression gate failed:\n  - ${failures.join('\n  - ')}`);
  }

  console.log('Regression gate passed against the recorded baseline.\n');
}

function writeResults(run: EvalRun): void {
  const existing = (() => {
    try {
      const content = readFileSync(RESULTS_FILE, 'utf-8');
      const index = content.indexOf('## Latency and the `ef_search` tradeoff');
      return index === -1 ? '' : `\n${content.slice(index)}`;
    } catch {
      return '';
    }
  })();

  const table = (results: ScopeResults) =>
    [
      '| Metric | Dense only | Sparse only | Hybrid (RRF) | Hybrid vs dense |',
      '| :--- | ---: | ---: | ---: | ---: |',
      metricRow('Recall@8', results, (m) => m.recallAt8, 2, '%'),
      metricRow('MRR', results, (m) => m.mrr, 4),
      metricRow('Context precision', results, (m) => m.contextPrecision, 4),
    ].join('\n');

  writeFileSync(
    RESULTS_FILE,
    `# Retrieval evaluation baseline

Produced by \`pnpm eval:retrieval --write\`. Every number below comes from calling
\`retrieve()\` against a real Postgres with pgvector, indexed with ${run.chunkCount}
chunks extracted from the PDFs in \`fixtures/pdf/\`, and scored against the
${run.questions} questions in \`evals/golden/corpus.jsonl\`. Nothing here is
simulated: the harness starts a container, migrates it, writes chunks, and runs
the same \`retrieve()\` the product calls.

## Document scope — find the right page in a known document

${table(run.document)}

## Corpus scope — find the right document, then the right page

${table(run.corpus)}

## Reading these numbers honestly

**Hybrid beats dense-only on every metric that moves.** In document scope it
wins MRR and context precision by a wide margin — fusion pulls the right passage
to rank 1 far more often than either leg alone — while recall@8 there is
saturated at 100% for every configuration, because each fixture is small enough
that eight chunks reach the answer. Treat document-scope recall@8 as a smoke
alarm rather than a quality signal. In corpus scope, where the pipeline has to
find the right document before the right page, hybrid gains more than nine
points of recall@8 over dense alone.

The sparse leg's contribution is larger here than it would be against a trained
embedding model, because the dense column is produced by a lexical hashing
vectorizer (see below). Read the *direction* of the delta, not its size.

One number is worth watching: corpus-scope MRR is slightly **lower** for hybrid
than for sparse alone. Fusion trades a little rank-1 precision for the recall it
gains, which is the trade RRF exists to make, and the 3-chunks-per-document
diversity cap spends top-8 slots spreading across documents. On this corpus —
five documents that repeat one identical body passage on nearly every page —
that spread costs more than it would on a corpus of genuinely distinct
documents.

## What these numbers do not measure

**Embedding quality.** The harness embeds with the deterministic hashing
vectorizer in \`@konusbitr/retrieval/testing\`, so the eval needs no provider key
and returns the same answer on every machine. It captures lexical overlap and
nothing else, which makes the dense column a floor rather than a forecast — a
real \`EMBEDDING_MODEL\` should do better on paraphrase and worse on nothing.

**Reranking.** No rerank model is configured in CI, and \`applyReranking\`
correctly becomes a pass-through when the role does not resolve, so the hybrid
column is fusion without a cross-encoder. Set \`RERANK_PROVIDER\` and
\`RERANK_MODEL\` and rerun to measure it.

## What the corpus is

Five fixture documents, small and deliberately repetitive: every page of
\`clean-text-10p\` and \`text-50p\` carries the same body passage under a heading
unique to that page, so the heading is the only discriminating token. A question
about that body is genuinely ambiguous, and its \`expectedPages\` lists every page
the evidence appears on rather than pretending to one.

Every golden question is grounded. \`evals/generate-golden.ts\` locates each
question's evidence string in the extracted page text and refuses to write a
question whose answer appears in no page of its document — which is how the
earlier version's questions about the gutter width, the paragraph count and the
\`/Rotate 90\` flag were caught: those are facts about \`fixtures/generate.py\`,
not about any document, and no retrieval system can answer them.

## The regression gate

\`pnpm eval:retrieval\` fails when document-scope recall@8, corpus-scope recall@8
or document-scope MRR falls more than 2 points below the baselines above, or when
hybrid stops beating dense-only on document-scope MRR.

\`pnpm eval:retrieval --broken-chunker\` re-indexes the same corpus in
\`shredded\` mode — fixed-width windows cut without regard for sentences, with page
provenance smeared across page breaks — and must fail the gate. It is a real
chunking change, not a counter that pretends to be one.
${existing}`,
    'utf-8',
  );
}

function metricRow(
  label: string,
  results: ScopeResults,
  pick: (metrics: EvalMetrics) => number,
  digits: number,
  suffix = '',
): string {
  const dense = pick(results.dense);
  const delta = pick(results.hybrid) - dense;
  return `| **${label}** | ${dense.toFixed(digits)}${suffix} | ${pick(results.sparse).toFixed(digits)}${suffix} | **${pick(results.hybrid).toFixed(digits)}${suffix}** | ${delta >= 0 ? '+' : ''}${delta.toFixed(digits)}${suffix} |`;
}

const invokedDirectly = process.argv[1]?.endsWith('eval-retrieval.ts') ?? false;
if (invokedDirectly) {
  runEval({
    brokenChunker: process.argv.includes('--broken-chunker'),
    write: process.argv.includes('--write'),
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
