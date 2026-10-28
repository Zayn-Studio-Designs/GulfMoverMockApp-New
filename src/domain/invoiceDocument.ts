import { formatHalala } from './money';
import type { PdfLine } from './pdf';

/**
 * Builds the text of an invoice / receipt / credit-note document from PERSISTED
 * records only (invoice row + lines). A sandbox or unpaid record is labelled as
 * such; nothing here can turn an unpaid invoice into a paid one.
 */
export interface InvoiceDocInput {
  readonly invoiceNumber: string;
  readonly documentType: string;
  readonly status: string;
  readonly settlementMode: string;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly netHalala: number;
  readonly vatHalala: number;
  readonly totalHalala: number;
  readonly amountPaidHalala: number;
  readonly sandbox: boolean;
  readonly buyer: Record<string, unknown>;
  readonly seller: Record<string, unknown>;
  readonly icv: number | null;
  readonly invoiceHash: string | null;
  readonly bookingReference: string;
  readonly lines: ReadonlyArray<{ description: string; quantity: number; unitHalala: number; netHalala: number; vatRateBp: number; vatHalala: number; totalHalala: number }>;
}

export function documentTitle(doc: Pick<InvoiceDocInput, 'documentType'>): string {
  return doc.documentType === 'tax_invoice' ? 'Tax invoice'
    : doc.documentType === 'simplified_tax_invoice' ? 'Simplified tax invoice'
      : 'Commercial invoice (not a tax invoice)';
}

export function invoicePdfLines(doc: InvoiceDocInput): PdfLine[] {
  const sar = (h: number) => `SAR ${formatHalala(h)}`;
  const seller = String(doc.seller.legal_name ?? '') || 'ATCO Ports Management & Marine Services (seller details pending)';
  const out: PdfLine[] = [
    { text: `Gulf Mover - ${documentTitle(doc)}`, size: 16, bold: true },
    { text: `Number ${doc.invoiceNumber}   Issued ${doc.issueDate}${doc.dueDate ? `   Due ${doc.dueDate}` : ''}`, gapBefore: 4 },
    { text: `Booking ${doc.bookingReference}   Status ${doc.status.toUpperCase()}   Settlement ${doc.settlementMode}` },
  ];
  if (doc.sandbox) out.push({ text: 'SANDBOX DOCUMENT - no real payment was made. Not valid for accounting.', bold: true, gapBefore: 6 });
  if (doc.documentType === 'commercial_invoice') out.push({ text: 'VAT treatment and seller VAT registration are pending ATCO Finance; this is not a ZATCA tax invoice.', gapBefore: 4 });
  out.push(
    { text: 'Seller', bold: true, gapBefore: 10 },
    { text: seller },
    { text: doc.seller.vat_number ? `VAT number ${String(doc.seller.vat_number)}` : 'VAT number: not configured' },
    { text: 'Buyer', bold: true, gapBefore: 8 },
    { text: String(doc.buyer.name ?? '-') },
  );
  if (doc.buyer.client_name) out.push({ text: `Client (agent booking): ${String(doc.buyer.client_name)}` });
  if (doc.buyer.po_reference) out.push({ text: `PO reference: ${String(doc.buyer.po_reference)}` });
  out.push({ text: 'Lines', bold: true, gapBefore: 10 });
  for (const l of doc.lines) {
    out.push({ text: l.description });
    out.push({ text: `   ${l.quantity} x ${sar(l.unitHalala)}   net ${sar(l.netHalala)}   VAT ${(l.vatRateBp / 100).toFixed(2)}% ${sar(l.vatHalala)}   total ${sar(l.totalHalala)}` });
  }
  out.push(
    { text: `Net ${sar(doc.netHalala)}`, gapBefore: 10 },
    { text: `VAT ${sar(doc.vatHalala)}` },
    { text: `Total ${sar(doc.totalHalala)}`, bold: true },
    { text: `Paid ${sar(doc.amountPaidHalala)}   Balance ${sar(doc.totalHalala - doc.amountPaidHalala)}` },
  );
  if (doc.icv !== null) out.push({ text: `Document counter ${doc.icv}   Integrity hash ${doc.invoiceHash ?? '-'}`, size: 8, gapBefore: 10 });
  out.push({ text: 'All amounts in Saudi riyals. Times are Asia/Riyadh. Generated from Gulf Mover records.', size: 8, gapBefore: 4 });
  return out;
}
