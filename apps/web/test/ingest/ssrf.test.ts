import { describe, expect, it } from 'vitest';
import {
  classifyAddress,
  fetchRemoteDocument,
  filenameFromDisposition,
  isBlockedAddress,
  type Opener,
  parseIngestUrl,
  type Resolver,
  resolvePublicHost,
  SsrfError,
} from '@/lib/ingest/ssrf';

/**
 * The SSRF guard, exercised against every class it is supposed to refuse.
 *
 * These are Phase 05's security acceptance criteria, and they are written
 * against injected DNS and an injected transport rather than a live network —
 * not for speed, but because the interesting cases (a name that answers
 * differently the second time, a redirect from a public host into a private
 * range) cannot be produced reliably any other way.
 */

/** A resolver that answers from a table, and fails for anything not in it. */
function resolverFor(table: Record<string, string[]>): Resolver {
  return async (hostname) => {
    const addresses = table[hostname];
    if (!addresses) throw new Error(`no such host: ${hostname}`);
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
}

/** Records what it was asked to open, and replies from a script. */
function openerFor(script: { status: number; headers?: Record<string, string>; body?: string }[]): {
  open: Opener;
  calls: { url: string; pinnedAddress: string }[];
} {
  const calls: { url: string; pinnedAddress: string }[] = [];
  let index = 0;

  const open: Opener = async (url, { pinnedAddress }) => {
    calls.push({ url: url.toString(), pinnedAddress });
    const step = script[index] ?? script.at(-1);
    index += 1;
    if (!step) throw new Error('the opener script ran out');

    return {
      status: step.status,
      headers: step.headers ?? {},
      body: (async function* stream() {
        if (step.body !== undefined) yield Buffer.from(step.body, 'latin1');
      })(),
      cancel: () => undefined,
    };
  };

  return { open, calls };
}

// ─── Address classification ──────────────────────────────────────────────────

describe('classifyAddress', () => {
  it.each([
    ['169.254.169.254', 'metadata'],
    ['169.254.1.1', 'link-local'],
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'shared'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['::1', 'loopback'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456::1', 'unique-local'],
    ['fe80::1', 'link-local'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:169.254.169.254', 'metadata'],
    ['64:ff9b::10.0.0.1', 'private'],
  ] as const)('refuses %s as %s', (address, kind) => {
    expect(classifyAddress(address)).toBe(kind);
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700::1111'])(
    'allows the public address %s',
    (address) => {
      expect(classifyAddress(address)).toBe('public');
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it('does not confuse 172.15 or 172.32 with the private 172.16/12 block', () => {
    expect(classifyAddress('172.15.0.1')).toBe('public');
    expect(classifyAddress('172.32.0.1')).toBe('public');
  });
});

// ─── URL shape ───────────────────────────────────────────────────────────────

describe('parseIngestUrl', () => {
  it.each([
    'file:///etc/passwd',
    'gopher://example.com/',
    'ftp://example.com/a.pdf',
    'data:,hello',
  ])('refuses the scheme in %s', (raw) => {
    expect(() => parseIngestUrl(raw)).toThrow(
      expect.objectContaining({ reason: 'blocked-scheme' }),
    );
  });

  it('refuses credentials embedded in the URL', () => {
    expect(() => parseIngestUrl('http://user:secret@example.com/a.pdf')).toThrow(
      expect.objectContaining({ reason: 'credentials-in-url' }),
    );
  });

  it('refuses something that is not a URL at all', () => {
    expect(() => parseIngestUrl('not a url')).toThrow(
      expect.objectContaining({ reason: 'invalid-url' }),
    );
  });

  it('accepts an ordinary https document link', () => {
    expect(parseIngestUrl(' https://example.com/report.pdf ').hostname).toBe('example.com');
  });
});

// ─── Resolution ──────────────────────────────────────────────────────────────

describe('resolvePublicHost', () => {
  it('refuses a literal loopback address without consulting DNS', async () => {
    await expect(resolvePublicHost('127.0.0.1', resolverFor({}))).rejects.toThrow(
      expect.objectContaining({ reason: 'blocked-address' }),
    );
  });

  it('refuses a name that resolves into a private range', async () => {
    const resolve = resolverFor({ 'internal.example.com': ['10.1.2.3'] });
    await expect(resolvePublicHost('internal.example.com', resolve)).rejects.toThrow(
      expect.objectContaining({ reason: 'blocked-address' }),
    );
  });

  it('refuses a name with one public answer and one private one', async () => {
    // Which address a connection would get is not ours to choose, so a mixed
    // answer is refused outright rather than filtered down to the safe half.
    const resolve = resolverFor({ 'mixed.example.com': ['93.184.216.34', '192.168.0.5'] });
    await expect(resolvePublicHost('mixed.example.com', resolve)).rejects.toThrow(
      expect.objectContaining({ reason: 'blocked-address' }),
    );
  });

  it('returns the address it approved, which is the one that gets connected to', async () => {
    const resolve = resolverFor({ 'example.com': ['93.184.216.34'] });
    await expect(resolvePublicHost('example.com', resolve)).resolves.toBe('93.184.216.34');
  });

  it('reports a name that does not resolve', async () => {
    await expect(resolvePublicHost('nowhere.invalid', resolverFor({}))).rejects.toThrow(
      expect.objectContaining({ reason: 'unresolvable' }),
    );
  });
});

// ─── The fetch, end to end ───────────────────────────────────────────────────

const PDF_BODY = '%PDF-1.7\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF';

describe('fetchRemoteDocument', () => {
  it('refuses http://169.254.169.254/ — the cloud metadata service', async () => {
    const { open, calls } = openerFor([{ status: 200, body: PDF_BODY }]);

    await expect(
      fetchRemoteDocument('http://169.254.169.254/latest/meta-data/iam/security-credentials/', {
        maxBytes: 1024,
        resolve: resolverFor({}),
        open,
      }),
    ).rejects.toThrow(expect.objectContaining({ reason: 'blocked-address' }));

    // Nothing was opened at all: the refusal happens before any connection.
    expect(calls).toHaveLength(0);
  });

  it('refuses http://localhost:9000/ even though the name looks innocuous', async () => {
    const { open, calls } = openerFor([{ status: 200, body: PDF_BODY }]);

    await expect(
      fetchRemoteDocument('http://localhost:9000/konusbitr/secret.pdf', {
        maxBytes: 1024,
        resolve: resolverFor({ localhost: ['127.0.0.1'] }),
        open,
      }),
    ).rejects.toThrow(expect.objectContaining({ reason: 'blocked-address' }));

    expect(calls).toHaveLength(0);
  });

  it('refuses a redirect from a public host into a private range', async () => {
    const { open, calls } = openerFor([
      { status: 302, headers: { location: 'http://10.0.0.5/internal.pdf' } },
      { status: 200, body: PDF_BODY },
    ]);

    await expect(
      fetchRemoteDocument('https://files.example.com/report.pdf', {
        maxBytes: 1024,
        resolve: resolverFor({ 'files.example.com': ['93.184.216.34'] }),
        open,
      }),
    ).rejects.toThrow(expect.objectContaining({ reason: 'blocked-address' }));

    // The first hop was allowed and opened; the second never was.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://files.example.com/report.pdf');
  });

  it('refuses a redirect that changes scheme to something non-web', async () => {
    const { open } = openerFor([
      { status: 301, headers: { location: 'file:///etc/passwd' } },
      { status: 200, body: PDF_BODY },
    ]);

    await expect(
      fetchRemoteDocument('https://files.example.com/report.pdf', {
        maxBytes: 1024,
        resolve: resolverFor({ 'files.example.com': ['93.184.216.34'] }),
        open,
      }),
    ).rejects.toThrow(expect.objectContaining({ reason: 'blocked-scheme' }));
  });

  it('refuses a DNS rebind — the second answer is checked, not remembered', async () => {
    // The classic attack: a name that answers with a public address while it is
    // being vetted and a private one when it is connected to. The guard resolves
    // on every hop and pins the address it approved into the socket, so the
    // rebind has to show itself as a resolution and gets caught.
    let answers = 0;
    const rebinding: Resolver = async () => {
      answers += 1;
      return answers === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }];
    };

    const { open, calls } = openerFor([
      { status: 302, headers: { location: 'https://rebind.example.com/step-2.pdf' } },
      { status: 200, body: PDF_BODY },
    ]);

    await expect(
      fetchRemoteDocument('https://rebind.example.com/report.pdf', {
        maxBytes: 1024,
        resolve: rebinding,
        open,
      }),
    ).rejects.toThrow(expect.objectContaining({ reason: 'blocked-address' }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.pinnedAddress).toBe('93.184.216.34');
  });

  it('caps redirects at three', async () => {
    const { open } = openerFor([
      { status: 302, headers: { location: 'https://files.example.com/1' } },
      { status: 302, headers: { location: 'https://files.example.com/2' } },
      { status: 302, headers: { location: 'https://files.example.com/3' } },
      { status: 302, headers: { location: 'https://files.example.com/4' } },
    ]);

    await expect(
      fetchRemoteDocument('https://files.example.com/report.pdf', {
        maxBytes: 1024,
        resolve: resolverFor({ 'files.example.com': ['93.184.216.34'] }),
        open,
      }),
    ).rejects.toThrow(expect.objectContaining({ reason: 'too-many-redirects' }));
  });

  it('refuses a declared Content-Length over the cap before reading anything', async () => {
    const { open } = openerFor([
      { status: 200, headers: { 'content-length': '999999' }, body: PDF_BODY },
    ]);

    await expect(
      fetchRemoteDocument('https://files.example.com/huge.pdf', {
        maxBytes: 1024,
        resolve: resolverFor({ 'files.example.com': ['93.184.216.34'] }),
        open,
      }),
    ).rejects.toThrow(expect.objectContaining({ reason: 'too-large' }));
  });

  it('refuses a body that exceeds the cap while streaming, whatever it declared', async () => {
    // A hostile server declares 1KB and sends more. The running total is what
    // actually stops the read; the declared length is only an early hint.
    const { open } = openerFor([
      { status: 200, headers: { 'content-length': '10' }, body: 'x'.repeat(5000) },
    ]);

    const remote = await fetchRemoteDocument('https://files.example.com/liar.pdf', {
      maxBytes: 1024,
      resolve: resolverFor({ 'files.example.com': ['93.184.216.34'] }),
      open,
    });

    await expect(drain(remote.body)).rejects.toThrow(
      expect.objectContaining({ reason: 'too-large' }),
    );
  });

  it('reports a non-2xx status rather than storing the error page', async () => {
    const { open } = openerFor([{ status: 404, body: 'not found' }]);

    await expect(
      fetchRemoteDocument('https://files.example.com/missing.pdf', {
        maxBytes: 1024,
        resolve: resolverFor({ 'files.example.com': ['93.184.216.34'] }),
        open,
      }),
    ).rejects.toThrow(expect.objectContaining({ reason: 'bad-status' }));
  });

  it('follows an allowed redirect and returns the final URL and body', async () => {
    const { open, calls } = openerFor([
      { status: 302, headers: { location: '/downloads/report.pdf' } },
      {
        status: 200,
        headers: {
          'content-type': 'application/pdf; charset=binary',
          'content-disposition': 'attachment; filename="Quarterly Report.pdf"',
        },
        body: PDF_BODY,
      },
    ]);

    const remote = await fetchRemoteDocument('https://files.example.com/latest', {
      maxBytes: 1024,
      resolve: resolverFor({ 'files.example.com': ['93.184.216.34'] }),
      open,
    });

    expect(remote.finalUrl).toBe('https://files.example.com/downloads/report.pdf');
    expect(remote.contentType).toBe('application/pdf');
    expect(remote.filename).toBe('Quarterly Report.pdf');
    expect((await drain(remote.body)).toString('latin1')).toBe(PDF_BODY);
    expect(calls).toHaveLength(2);
  });

  it('raises SsrfError, never a bare Error, so the route can map it to a 400', async () => {
    await expect(
      fetchRemoteDocument('file:///etc/passwd', { maxBytes: 1024, resolve: resolverFor({}) }),
    ).rejects.toBeInstanceOf(SsrfError);
  });
});

describe('filenameFromDisposition', () => {
  it.each([
    ['attachment; filename="report.pdf"', 'report.pdf'],
    ['attachment; filename=report.pdf', 'report.pdf'],
    ["attachment; filename*=UTF-8''rapor%20%C3%A7.pdf", 'rapor ç.pdf'],
    [undefined, undefined],
    ['attachment', undefined],
  ])('reads %s', (header, expected) => {
    expect(filenameFromDisposition(header)).toBe(expected);
  });
});

async function drain(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
