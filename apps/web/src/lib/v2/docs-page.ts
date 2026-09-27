/**
 * `/v2/docs` — the reference, rendered from the generated document.
 *
 * Scalar is loaded from its CDN rather than bundled. The page has exactly one
 * job, it is served to developers reading documentation rather than to the
 * product's own users, and adding a megabyte of API-reference UI to the
 * application bundle so that a documentation page can be offline would be
 * paying the cost in the wrong place. The specification itself is served by
 * this instance and is complete without the page.
 *
 * Nothing here is interpolated from anything: the whole document is a constant,
 * and the only dynamic thing on the page is the URL it fetches, which is
 * same-origin and relative.
 */
export function docsPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Konusbitr API reference</title>
    <style>
      body { margin: 0; background: #faf7f2; }
    </style>
  </head>
  <body>
    <script id="api-reference" data-url="/v2/openapi.json"></script>
    <script>
      var configuration = { theme: 'default', hideDownloadButton: false };
      document.getElementById('api-reference').dataset.configuration = JSON.stringify(configuration);
    </script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;
}
