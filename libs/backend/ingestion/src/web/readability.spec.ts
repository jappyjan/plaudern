import { decodeHtmlEntities, extractReadableContent, extractReadableText, extractTitle } from './readability';

describe('readability', () => {
  const page = `<!doctype html>
<html>
  <head>
    <title>Interesting Article — Example Blog</title>
    <meta property="og:title" content="Interesting Article" />
    <style>body { color: red; }</style>
    <script>console.log('<p>not content</p>');</script>
  </head>
  <body>
    <nav><a href="/">Home</a><a href="/about">About</a></nav>
    <header><h1>Example Blog</h1></header>
    <article>
      <h1>Interesting Article</h1>
      <p>First paragraph with an &amp; ampersand and a &euro; sign.</p>
      <p>Second&nbsp;paragraph
         spanning lines.</p>
      <ul><li>point one</li><li>point two</li></ul>
    </article>
    <footer>© 2026 Example Blog — all rights reserved</footer>
  </body>
</html>`;

  it('prefers the og:title, decoding entities', () => {
    expect(extractTitle(page)).toBe('Interesting Article');
  });

  it('falls back to <title> when no og:title exists', () => {
    expect(extractTitle('<html><head><title>Only &amp; Title</title></head></html>')).toBe(
      'Only & Title',
    );
  });

  it('extracts readable text from the article region, dropping chrome', () => {
    const text = extractReadableText(page);
    expect(text).toContain('First paragraph with an & ampersand and a € sign.');
    expect(text).toContain('Second paragraph spanning lines.');
    expect(text).toContain('point one');
    // nav/header/footer/script/style content must not leak in.
    expect(text).not.toContain('About');
    expect(text).not.toContain('all rights reserved');
    expect(text).not.toContain('console.log');
    expect(text).not.toContain('color: red');
  });

  it('drops nav/header/footer/aside when there is no article/main region', () => {
    const text = extractReadableText(
      '<body><nav>menu</nav><div><p>real content</p></div><footer>legal</footer></body>',
    );
    expect(text).toBe('real content');
  });

  it('keeps paragraph structure as newlines', () => {
    const text = extractReadableText('<body><p>one</p><p>two</p></body>');
    expect(text).toBe('one\ntwo');
  });

  it('decodes numeric and hex entities and ignores invalid code points', () => {
    expect(decodeHtmlEntities('caf&#233; &#x1F600; &#0; &unknown;')).toBe('café 😀  &unknown;');
  });

  it('returns both title and text', () => {
    const content = extractReadableContent(page);
    expect(content.title).toBe('Interesting Article');
    expect(content.text).toContain('First paragraph');
  });
});
