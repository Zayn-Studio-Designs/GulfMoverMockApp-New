// CSV export helpers (Phase 12). Pure and testable; only downloadCsv touches the browser.

/** RFC-4180 style escaping: quotes doubled, field always wrapped — stable formatting. */
export function csvEscape(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/** Builds a CSV document with a heading row from column headers + row arrays. */
export function toCsv(headers: readonly string[], rows: ReadonlyArray<readonly unknown[]>): string {
  const head = headers.map(csvEscape).join(',');
  const body = rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
  return body ? `${head}\r\n${body}` : head;
}

/** Downloads a CSV as demo data; falls back silently when the browser blocks it. */
export function downloadCsv(filename: string, csv: string): boolean {
  try {
    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  } catch {
    return false;
  }
}
