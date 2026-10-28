/**
 * Minimal, dependency-free PDF 1.4 writer for printable invoices, receipts,
 * credit notes and report summaries. Uses the standard Helvetica font, so it
 * supports Latin text only; Arabic documents use the HTML print view instead
 * (browser "Save as PDF"), which renders RTL correctly.
 */
export interface PdfLine {
  readonly text: string;
  readonly size?: number;
  readonly bold?: boolean;
  readonly gapBefore?: number;
}

const PAGE_W = 595; // A4 portrait in points
const PAGE_H = 842;
const MARGIN = 50;

/** Keeps printable ASCII/Latin-1 only and escapes PDF string delimiters. */
export function pdfSafeText(text: string): string {
  return text
    .replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/→/g, '->')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
    .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function buildPdf(title: string, lines: readonly PdfLine[]): Uint8Array {
  const pages: string[][] = [[]];
  let y = PAGE_H - MARGIN;
  for (const line of lines) {
    const size = line.size ?? 10;
    y -= (line.gapBefore ?? 0) + size + 4;
    if (y < MARGIN) { pages.push([]); y = PAGE_H - MARGIN - size - 4; }
    const font = line.bold ? 'F2' : 'F1';
    // Wrap long lines at ~95 characters for 10pt.
    const max = Math.max(20, Math.floor(95 * 10 / size));
    const chunks = line.text.length > max ? line.text.match(new RegExp(`.{1,${max}}(\\s|$)`, 'g')) ?? [line.text] : [line.text];
    chunks.forEach((chunk, i) => {
      if (i > 0) { y -= size + 4; if (y < MARGIN) { pages.push([]); y = PAGE_H - MARGIN - size - 4; } }
      pages[pages.length - 1].push(`BT /${font} ${size} Tf ${MARGIN} ${y} Td (${pdfSafeText(chunk.trimEnd())}) Tj ET`);
    });
  }

  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };
  const catalog = add('');
  const pagesObj = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const content of pages) {
    const stream = content.join('\n');
    const contentObj = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${contentObj} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${pdfSafeText(title)}) /Producer (Gulf Mover) >>`);

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Latin-1 bytes (content is restricted to that range above).
  return Uint8Array.from(out, c => c.charCodeAt(0) & 0xff);
}

export function downloadBytes(bytes: Uint8Array, filename: string, mime: string): void {
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
