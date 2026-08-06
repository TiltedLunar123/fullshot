/**
 * Minimal PDF writer.
 *
 * PDF embeds JPEG natively: an image XObject with `/Filter /DCTDecode` takes
 * the raw JFIF bytes with no re-encoding. That makes a valid multi-page
 * image PDF a few hundred lines of byte assembly, so Fullshot ships PDF export
 * with no dependency and no build step.
 *
 * Paginating in image space also means a very tall capture never needs one
 * enormous canvas: each page is rendered from its own strip.
 */
globalThis.FS = globalThis.FS || {};

FS.pdf = {
  /** Points per inch. PDF's default user space unit is 1/72". */
  PAGE_SIZES: {
    a4: [595.28, 841.89],
    letter: [612, 792],
  },

  /**
   * @param {Array<{jpeg: Uint8Array, widthPx: number, heightPx: number,
   *   drawWidthPt: number, drawHeightPt: number, offsetXPt: number, offsetYPt: number}>} pages
   * @param {{pageWidthPt: number, pageHeightPt: number, title?: string}} options
   * @returns {Uint8Array}
   */
  build(pages, { pageWidthPt, pageHeightPt, title = 'Screenshot' }) {
    if (!pages.length) throw new Error('a PDF needs at least one page');

    const encoder = new TextEncoder();
    const chunks = [];
    let length = 0;

    const write = (data) => {
      const bytes = typeof data === 'string' ? encoder.encode(data) : data;
      chunks.push(bytes);
      length += bytes.length;
      return length;
    };

    // Object 1 is the catalog, 2 the page tree, then three objects per page,
    // and the document information dictionary last.
    const objectCount = 3 + pages.length * 3;
    const infoObjNum = objectCount;
    // offsets[n] is the byte offset of object n. Index 0 is the free entry.
    const offsets = new Array(objectCount + 1).fill(0);

    const beginObject = (n) => {
      offsets[n] = length;
      write(`${n} 0 obj\n`);
    };
    const endObject = () => write('endobj\n');

    const pageObjNum = (i) => 3 + i * 3;
    const contentObjNum = (i) => 4 + i * 3;
    const imageObjNum = (i) => 5 + i * 3;

    // The %-prefixed binary comment marks the file as containing binary data,
    // which stops naive tools from mangling it in text mode.
    write('%PDF-1.4\n');
    write(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    beginObject(1);
    write('<< /Type /Catalog /Pages 2 0 R >>\n');
    endObject();

    beginObject(2);
    const kids = pages.map((_, i) => `${pageObjNum(i)} 0 R`).join(' ');
    write(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\n`);
    endObject();

    pages.forEach((page, i) => {
      beginObject(pageObjNum(i));
      write(
        `<< /Type /Page /Parent 2 0 R ` +
          `/MediaBox [0 0 ${fmt(pageWidthPt)} ${fmt(pageHeightPt)}] ` +
          `/Resources << /XObject << /Im0 ${imageObjNum(i)} 0 R >> >> ` +
          `/Contents ${contentObjNum(i)} 0 R >>\n`
      );
      endObject();

      // `cm` maps the unit square onto the placement rectangle, then `Do`
      // paints the image into it. q/Q keep the transform local to this page.
      const content =
        `q\n${fmt(page.drawWidthPt)} 0 0 ${fmt(page.drawHeightPt)} ` +
        `${fmt(page.offsetXPt)} ${fmt(page.offsetYPt)} cm\n/Im0 Do\nQ\n`;
      const contentBytes = encoder.encode(content);

      beginObject(contentObjNum(i));
      write(`<< /Length ${contentBytes.length} >>\nstream\n`);
      write(contentBytes);
      write('endstream\n');
      endObject();

      beginObject(imageObjNum(i));
      write(
        `<< /Type /XObject /Subtype /Image ` +
          `/Width ${page.widthPx} /Height ${page.heightPx} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
          `/Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`
      );
      write(page.jpeg);
      write('\nendstream\n');
      endObject();
    });

    // The trailer's /Info has to be an indirect reference, not a dictionary
    // written out in place. Readers vary in how strict they are about it, and
    // the ones that are strict reject the whole file rather than skip the
    // metadata.
    beginObject(infoObjNum);
    write(`<< /Title (${escapeText(title)}) /Producer (Fullshot) >>\n`);
    endObject();

    // Cross-reference table. Every entry is exactly 20 bytes, including the
    // trailing two-character EOL, or readers reject the file.
    const xrefOffset = length;
    write(`xref\n0 ${objectCount + 1}\n`);
    write('0000000000 65535 f \n');
    for (let n = 1; n <= objectCount; n++) {
      write(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
    }

    write(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R /Info ${infoObjNum} 0 R >>\n`);
    write(`startxref\n${xrefOffset}\n%%EOF\n`);

    const out = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  },
};

/** PDF reals: trim to 4 decimals and drop a trailing dot. */
function fmt(n) {
  return Number(n.toFixed(4)).toString();
}

/** Literal strings are parenthesised, so those and backslashes need escaping. */
function escapeText(text) {
  return (
    String(text)
      // Keep it to printable ASCII; anything else would need a UTF-16 string.
      .replace(/[^\x20-\x7e]/g, '')
      // Cut to length BEFORE escaping, never after.
      //
      // Escaping first and slicing afterwards can cut a two-character escape in
      // half. The backslash left behind then escapes the closing parenthesis of
      // the string itself, so /Title never terminates and swallows the rest of
      // the information dictionary. A page whose title is long and contains a
      // parenthesis, which is ordinary, produced a PDF that strict readers
      // reject.
      .slice(0, 200)
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
  );
}
