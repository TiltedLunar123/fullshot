import assert from 'node:assert/strict';
import test from 'node:test';
import { loadLibs } from './helper.mjs';

const FS = await loadLibs(['plan', 'pdf']);

/** A stand-in for encoded JPEG bytes; the writer treats the payload opaquely. */
function fakeJpeg(length = 64) {
  const bytes = new Uint8Array(length);
  bytes[0] = 0xff;
  bytes[1] = 0xd8; // SOI
  for (let i = 2; i < length - 2; i++) bytes[i] = i % 256;
  bytes[length - 2] = 0xff;
  bytes[length - 1] = 0xd9; // EOI
  return bytes;
}

function page(overrides = {}) {
  return {
    jpeg: fakeJpeg(),
    widthPx: 800,
    heightPx: 600,
    drawWidthPt: 547.28,
    drawHeightPt: 410.46,
    offsetXPt: 24,
    offsetYPt: 407.43,
    ...overrides,
  };
}

const decode = (bytes) => Buffer.from(bytes).toString('latin1');

test('produces a well-formed PDF header and trailer', () => {
  const pdf = FS.pdf.build([page()], { pageWidthPt: 595.28, pageHeightPt: 841.89 });
  const text = decode(pdf);

  assert.ok(text.startsWith('%PDF-1.4\n'), 'must start with a PDF header');
  assert.ok(text.trimEnd().endsWith('%%EOF'), 'must end with %%EOF');
  assert.ok(text.includes('/Type /Catalog'));
  assert.ok(text.includes('/Type /Pages'));
  assert.ok(text.includes('/Filter /DCTDecode'), 'JPEG must embed via DCTDecode');
});

test('every xref offset points at the object it claims', () => {
  // This is the failure mode of hand-written PDFs: a single byte of drift in
  // any stream length silently corrupts every offset after it.
  const pdf = FS.pdf.build([page(), page(), page()], {
    pageWidthPt: 595.28,
    pageHeightPt: 841.89,
  });
  const text = decode(pdf);

  // Locate the table through startxref, not by searching for "xref": the
  // literal "startxref" contains it, so a naive lastIndexOf lands past the end.
  const pointer = /startxref\n(\d+)\n/.exec(text);
  assert.ok(pointer, 'startxref missing');
  const xrefStart = Number(pointer[1]);
  assert.ok(text.slice(xrefStart).startsWith('xref\n'), 'startxref does not point at the table');

  const header = /^xref\n0 (\d+)\n/.exec(text.slice(xrefStart));
  assert.ok(header, 'xref subsection header missing');
  const count = Number(header[1]);

  const tableStart = xrefStart + header[0].length;
  // Entry 0 is the free-list head; objects start at 1.
  for (let n = 1; n < count; n++) {
    const entry = text.slice(tableStart + n * 20, tableStart + (n + 1) * 20);
    assert.equal(entry.length, 20, `xref entry ${n} is not exactly 20 bytes`);
    // 10-digit offset, 5-digit generation, type, then a two-character EOL.
    // The spec allows " \n" or "\r\n" for that EOL; this writer uses " \n".
    assert.match(
      entry,
      /^\d{10} \d{5} n(?: \n|\r\n)$/,
      `xref entry ${n} is malformed: ${JSON.stringify(entry)}`
    );

    const offset = Number(entry.slice(0, 10));
    const atOffset = text.slice(offset, offset + 24);
    assert.ok(
      atOffset.startsWith(`${n} 0 obj`),
      `xref says object ${n} is at ${offset}, but that byte holds ${JSON.stringify(atOffset.slice(0, 16))}`
    );
  }
});

test('startxref points at the xref table', () => {
  const pdf = FS.pdf.build([page(), page()], { pageWidthPt: 612, pageHeightPt: 792 });
  const text = decode(pdf);

  const match = /startxref\n(\d+)\n/.exec(text);
  assert.ok(match, 'startxref missing');
  const offset = Number(match[1]);
  assert.ok(text.slice(offset).startsWith('xref\n'), 'startxref does not point at the xref table');
});

test('object count and page tree agree', () => {
  const pdf = FS.pdf.build([page(), page(), page(), page()], {
    pageWidthPt: 612,
    pageHeightPt: 792,
  });
  const text = decode(pdf);

  assert.ok(text.includes('/Count 4'), 'page tree must report four pages');
  // Catalog + page tree + three objects per page + the document info dict.
  const expected = 3 + 4 * 3;
  assert.ok(text.includes(`/Size ${expected + 1}`), `trailer /Size should be ${expected + 1}`);
  assert.equal((text.match(/\/Type \/Page\b(?!s)/g) ?? []).length, 4);
});

test('the trailer references /Info indirectly, as the spec requires', () => {
  // A dictionary written straight into the trailer parses in lenient readers
  // and is rejected outright by strict ones, so the difference is a file that
  // either opens everywhere or nowhere.
  const pdf = FS.pdf.build([page(), page()], { pageWidthPt: 612, pageHeightPt: 792 });
  const text = decode(pdf);

  const trailer = text.slice(text.lastIndexOf('trailer'));
  const ref = /\/Info (\d+) 0 R/.exec(trailer);
  assert.ok(ref, `trailer must point at an Info object, got: ${trailer.split('\n')[1]}`);
  assert.ok(!/\/Info <</.test(trailer), 'Info must not be inlined in the trailer');

  // And that object number has to actually exist and hold the metadata.
  const objectAt = text.indexOf(`${ref[1]} 0 obj`);
  assert.ok(objectAt > 0, `Info object ${ref[1]} is missing`);
  assert.ok(text.slice(objectAt, objectAt + 120).includes('/Producer (Fullshot)'));
});

test('image bytes survive the round trip unmodified', () => {
  const jpeg = fakeJpeg(128);
  const pdf = FS.pdf.build([page({ jpeg })], { pageWidthPt: 612, pageHeightPt: 792 });

  // Locate the image stream and compare byte for byte.
  const text = decode(pdf);
  const marker = text.indexOf('/Filter /DCTDecode');
  const streamAt = text.indexOf('stream\n', marker) + 'stream\n'.length;
  const embedded = pdf.slice(streamAt, streamAt + jpeg.length);

  assert.deepEqual([...embedded], [...jpeg], 'JPEG payload was altered during embedding');
});

test('declared stream length matches the real payload length', () => {
  const jpeg = fakeJpeg(321);
  const pdf = FS.pdf.build([page({ jpeg })], { pageWidthPt: 612, pageHeightPt: 792 });
  const text = decode(pdf);

  const match = /\/Filter \/DCTDecode \/Length (\d+) >>/.exec(text);
  assert.ok(match, 'image dictionary missing a Length');
  assert.equal(Number(match[1]), 321);
});

test('page geometry is written into the content stream', () => {
  const pdf = FS.pdf.build(
    [page({ drawWidthPt: 500, drawHeightPt: 300, offsetXPt: 24, offsetYPt: 100 })],
    { pageWidthPt: 612, pageHeightPt: 792 }
  );
  const text = decode(pdf);
  assert.ok(text.includes('500 0 0 300 24 100 cm'), 'placement matrix missing or wrong');
  assert.ok(text.includes('/Im0 Do'));
  assert.ok(text.includes('/MediaBox [0 0 612 792]'));
});

test('title is escaped so parentheses cannot break the string', () => {
  const pdf = FS.pdf.build([page()], {
    pageWidthPt: 612,
    pageHeightPt: 792,
    title: 'Report (draft) \\ v2',
  });
  const text = decode(pdf);
  assert.ok(text.includes('/Title (Report \\(draft\\) \\\\ v2)'), 'title escaping is wrong');
});

test('a long title is cut before it is escaped, never through an escape', () => {
  // Escaping first and truncating afterwards can slice a two-character escape
  // in half. The leftover backslash then escapes the closing parenthesis of the
  // string itself, so /Title never terminates and swallows the rest of the
  // dictionary. One character of padding in front of the parentheses is what
  // moves the cut onto an odd boundary.
  const title = `A${'('.repeat(150)}`;
  const pdf = FS.pdf.build([page()], { pageWidthPt: 612, pageHeightPt: 792, title });
  const text = decode(pdf);

  const info = /\/Title \((.*)\) \/Producer/.exec(text);
  assert.ok(info, '/Title did not terminate before /Producer');

  // Count the backslashes running back from the end: an odd number means the
  // last one is escaping the delimiter rather than being escaped itself.
  const trailing = /\\*$/.exec(info[1])[0].length;
  assert.equal(trailing % 2, 0, 'title ends on a dangling escape');
});

test('rejects an empty page list rather than emitting an invalid file', () => {
  assert.throws(() => FS.pdf.build([], { pageWidthPt: 612, pageHeightPt: 792 }));
});

test('paginate output feeds straight into build', () => {
  // The two modules have to agree on field names; this catches drift.
  const layout = FS.plan.paginate({
    imageWidthPx: 1200,
    imageHeightPx: 3000,
    pageWidthPt: 595.28,
    pageHeightPt: 841.89,
    marginPt: 24,
  });
  const pages = layout.map((p) => ({
    jpeg: fakeJpeg(),
    widthPx: 1200,
    heightPx: p.sourceHeight,
    drawWidthPt: p.drawWidthPt,
    drawHeightPt: p.drawHeightPt,
    offsetXPt: p.offsetXPt,
    offsetYPt: p.offsetYPt,
  }));

  const pdf = FS.pdf.build(pages, { pageWidthPt: 595.28, pageHeightPt: 841.89 });
  const text = decode(pdf);
  assert.ok(text.includes(`/Count ${pages.length}`));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
});
