#!/usr/bin/env node
/**
 * A deterministic stand-in for the chat model, for the end-to-end tests.
 *
 * The citation test has to assert that a *specific* passage on a *specific*
 * page lights up in the viewer. A real model cannot be asked for that: it will
 * cite whatever it finds most relevant, which is the correct behaviour and
 * useless as a fixture. So this server speaks the OpenAI-compatible streaming
 * protocol and answers by quoting the first retrieved chunk back verbatim.
 *
 * What it deliberately does **not** stub is everything else. Retrieval runs for
 * real, the citation verifier runs for real against the real chunk text, the
 * bounding box comes from the real parse, and the viewer converts it with the
 * real geometry. If the worker writes a flipped box, this test fails — which is
 * the entire reason it exists.
 *
 * The chunk tag format is `[[chk_…, p42]]` and comes from `buildContext` in
 * `packages/ai/src/context.ts`. If that changes, this changes with it, and the
 * test goes red rather than silently passing on a stub that cites nothing.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.MODEL_STUB_PORT ?? 4010);

const CHUNK_TAG = /\[\[(chk_[A-Za-z0-9_-]+),\s*p(\d+)\]\]\n([\s\S]*?)(?=\n\n\[\[chk_|$)/;

const REFUSAL = 'I cannot find the answer to this question in the provided document.';

/** The first reasonably long sentence of a passage, as a verbatim quote. */
function firstSentence(text) {
  const sentences = text
    .split(/(?<=[.?!])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 25);
  return sentences[0] ?? text.trim().slice(0, 200);
}

function answerFor(prompt) {
  const match = CHUNK_TAG.exec(prompt);
  if (!match) return { text: REFUSAL, citations: [] };

  const [, chunkId, page, body] = match;
  // The section path, when the chunk has one, is the first line of the body.
  const passage = body.trim();
  const quote = firstSentence(passage);

  return {
    text: `According to the document, ${quote} [[${chunkId}, ${page}]]`,
    citations: [{ chunkId, page: Number(page), quote }],
  };
}

function sseChunk(id, delta) {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'konusbitr-e2e-stub',
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`;
}

const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    return;
  }

  if (!request.url?.endsWith('/chat/completions')) {
    response.writeHead(404).end('{}');
    return;
  }

  const body = [];
  request.on('data', (piece) => body.push(piece));
  request.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(body).toString('utf8'));
    } catch {
      response.writeHead(400).end('{}');
      return;
    }

    const userMessages = (payload.messages ?? []).filter((message) => message.role === 'user');
    const lastUserMessage = userMessages[userMessages.length - 1];
    const lastContent =
      typeof lastUserMessage?.content === 'string'
        ? lastUserMessage.content
        : (lastUserMessage?.content ?? []).map((part) => part.text ?? '').join('');

    const prompt = userMessages
      .map((message) =>
        typeof message.content === 'string'
          ? message.content
          : (message.content ?? []).map((part) => part.text ?? '').join(''),
      )
      .join('\n');

    if (!payload.stream) {
      // Check for query rewriting
      const rewriteMatch = /Latest Question:\s*([\s\S]*)$/i.exec(prompt);
      if (rewriteMatch) {
        const rewritten = rewriteMatch[1].trim();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'konusbitr-e2e-stub',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: rewritten },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        );
        return;
      }

      // Check for conversation auto-titling
      const titleMatch = /User question:\s*([\s\S]*?)(?:\nAssistant answer:|$)/i.exec(prompt);
      if (titleMatch) {
        const title = titleMatch[1].trim().slice(0, 50);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'konusbitr-e2e-stub',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: title || 'Document Q&A' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        );
        return;
      }

      // Check for starter question suggestions
      const isSuggest = (payload.messages ?? []).some(
        (m) => typeof m.content === 'string' && m.content.includes('DOCUMENT ABSTRACT'),
      );
      if (isSuggest) {
        const questions =
          '1. What is this document about?\n2. What are the key findings?\n3. Who wrote this document?\n4. What methodology was used?';
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'konusbitr-e2e-stub',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: questions },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        );
        return;
      }

      const { text } = answerFor(lastContent || prompt);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'konusbitr-e2e-stub',
          choices: [
            { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
      );
      return;
    }

    const { text, citations } = answerFor(lastContent || prompt);

    const full = `${text}\n\n<citations>\n${JSON.stringify(citations, null, 2)}\n</citations>`;

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const id = `chatcmpl-${Date.now()}`;
    response.write(sseChunk(id, { role: 'assistant', content: '' }));

    // Sent in pieces, with a beat between them, so the test exercises a real
    // stream rather than one frame that happens to contain everything.
    const pieces = full.match(/[\s\S]{1,48}/g) ?? [];
    let index = 0;

    const timer = setInterval(() => {
      const piece = pieces[index++];
      if (piece === undefined) {
        clearInterval(timer);
        response.write(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'konusbitr-e2e-stub',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          })}\n\n`,
        );
        response.end('data: [DONE]\n\n');
        return;
      }
      response.write(sseChunk(id, { content: piece }));
    }, 8);

    response.on('close', () => clearInterval(timer));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  // biome-ignore lint/suspicious/noConsole: a test server announcing its port is the only way to debug a Playwright webServer that will not start.
  console.log(`model stub listening on http://127.0.0.1:${PORT}/v1`);
});
