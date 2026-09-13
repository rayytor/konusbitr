/**
 * Query-side stop words.
 *
 * `chunks.tsv` is built with the `simple` text search configuration, which does
 * no stemming and — crucially — strips no stop words, because the corpus is
 * multilingual and a language-specific configuration would mangle every
 * document that is not in that language. That is the right call for the
 * **index**: every token a document contains stays findable, exactly as written.
 *
 * It is not the right call for the **query**. A natural-language question is
 * mostly function words, and the sparse leg ORs its terms so that a passage
 * matching some of them still ranks. Put together, "What was Subscriptions
 * revenue in 2023?" matches any passage containing "what", "was" or "in" — which
 * on a real corpus is all of it. Measured on the 100k-chunk benchmark, the query
 * matched 98,485 of 100,000 chunks and `ts_rank_cd` then had to score and sort
 * every one: 558ms p50, 1269ms p95, against a 400ms budget. Dropping the
 * function words left 1,515 matches, the same top 40, and 13ms p50.
 *
 * So the list below is applied to the query and never to the index. It is
 * deliberately small and conservative — only words that carry no retrieval
 * signal in any document — and it covers English and Turkish because those are
 * the two languages this project's own corpus is written in. Adding a language
 * here is additive and safe; a word that should not have been added costs recall
 * on queries that hinge on it, which is why the list stops at function words.
 */
const STOP_WORDS = new Set([
  // English
  'a',
  'about',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'being',
  'but',
  'by',
  'can',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'many',
  'much',
  'of',
  'on',
  'or',
  'our',
  'so',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'whom',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
  // Turkish
  'ama',
  'bir',
  'bu',
  'da',
  'daha',
  'de',
  'gibi',
  'hangi',
  'ile',
  'için',
  'kadar',
  'kim',
  'mi',
  'mu',
  'mı',
  'mü',
  'nasıl',
  'ne',
  'nedir',
  'nerede',
  've',
  'veya',
  'çok',
  'şu',
]);

/**
 * Drop function words from a query, leaving its content words.
 *
 * Quoted phrases pass through untouched — a phrase is an explicit instruction
 * about word order and the words inside it are not the caller's function words
 * to discard — and so does anything prefixed with `-`, which `websearch_to_tsquery`
 * reads as an exclusion.
 *
 * Returns the query unchanged when nothing would be left: "what is it" is a poor
 * query, but answering it against no terms at all is worse than answering it
 * slowly.
 */
export function dropStopWords(query: string): string {
  const tokens = query.match(/"[^"]*"|\S+/g);
  if (!tokens) {
    return query;
  }

  const kept = tokens.filter((token) => {
    if (token.startsWith('"') || token.startsWith('-')) {
      return true;
    }
    const bare = token.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}%$+]+$/gu, '');
    return bare.length > 0 && !STOP_WORDS.has(bare);
  });

  const rewritten = kept.join(' ').trim();
  return rewritten.length > 0 ? rewritten : query;
}
