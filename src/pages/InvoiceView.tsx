import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { useLanguage } from '../context/LanguageContext';
import { getInvoice, type InvoiceV2 } from '../lib/phase8Service';
import { formatSar } from '../domain/money';
import { buildPdf, downloadBytes } from '../domain/pdf';
import { invoicePdfLines } from '../domain/invoiceDocument';
import { ProdPageHeader, dataErrorKey } from '../components/ProductionUi';

/**
 * Printable invoice / receipt (`/invoices/:id`). Rendered from the persisted invoice
 * under RLS (customer, company admin or Finance). "Print" uses the browser's PDF
 * printer and supports Arabic/RTL; "Download PDF" produces a Latin-text PDF.
 */
export default function InvoiceView() {
  const { id = '' } = useParams();
  const { t, lang } = useLanguage();
  const [invoice, setInvoice] = useState<InvoiceV2 | null | undefined>(undefined);
  const [error, setError] = useState('');
  useEffect(() => { getInvoice(id).then(setInvoice).catch(e => setError(dataErrorKey(e))); }, [id]);

  const docKey = invoice?.documentType === 'tax_invoice' ? 'p8DocTax' : invoice?.documentType === 'simplified_tax_invoice' ? 'p8DocSimplified' : 'p8DocCommercial';

  return (
    <>
      <div className="no-print"><ProdPageHeader titleKey="p8InvoiceTitle" /></div>
      {error && <div className="notice danger" role="alert">{t(error)}</div>}
      {!error && invoice === undefined && <div className="card card-pad" role="status">{t('p4Loading')}</div>}
      {invoice === null && <div className="card card-pad"><div className="notice warn" role="alert">{t('pbNotFound')}</div></div>}
      {invoice && (
        <>
          <div className="row no-print" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
            <Link className="link-btn" to={`/bookings/${invoice.bookingReference}`}>← {t('pbBackToList')}</Link>
            <button type="button" className="btn btn-outline btn-small" onClick={() => window.print()}>{t('p8Print')}</button>
            <button type="button" className="btn btn-outline btn-small"
              onClick={() => downloadBytes(buildPdf(invoice.invoiceNumber, invoicePdfLines(invoice)), `${invoice.invoiceNumber}.pdf`, 'application/pdf')}>{t('p8DownloadPdf')}</button>
          </div>
          <article className="card card-pad print-area" aria-labelledby="inv-title">
            <div className="between" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
              <div>
                <h2 id="inv-title" className="card-title">{t(docKey)}</h2>
                <div className="mono">{invoice.invoiceNumber}</div>
                <div className="muted small">{t('p8IssueDate')}: <span className="mono">{invoice.issueDate}</span>{invoice.dueDate && <> · {t('p8DueDate')}: <span className="mono">{invoice.dueDate}</span></>}</div>
                <div className="muted small">{t('pbReference')}: <span className="mono">{invoice.bookingReference}</span></div>
              </div>
              {invoice.qrTlv && <div aria-label={t('p8ZatcaQr')}><QRCodeSVG value={invoice.qrTlv} size={120} /></div>}
            </div>
            {invoice.sandbox && invoice.status === 'paid' && <div className="notice warn" style={{ marginTop: 12 }}><strong>{t('p8SandboxPaidNotice')}</strong></div>}
            {invoice.sandbox && invoice.status !== 'paid' && <div className="notice warn" style={{ marginTop: 12 }}><strong>{t('p8SandboxDoc')}</strong></div>}
            {invoice.documentType === 'commercial_invoice' && <div className="notice blue" style={{ marginTop: 12 }}>{t('p8NotTaxInvoice')}</div>}
            <div className="form-grid" style={{ marginTop: 14 }}>
              <div className="inset small">
                <strong>{t('p8Seller')}</strong>
                <div>{String(invoice.seller.legal_name ?? '') || t('p8SellerPending')}</div>
                <div dir="ltr">{invoice.seller.vat_number ? `VAT ${String(invoice.seller.vat_number)}` : t('p8VatNumberPending')}</div>
              </div>
              <div className="inset small">
                <strong>{t('p8Buyer')}</strong>
                <div>{String(invoice.buyer.name ?? '—')}</div>
                {invoice.buyer.client_name ? <div>{t('p8ClientName')}: {String(invoice.buyer.client_name)}</div> : null}
                {invoice.buyer.po_reference ? <div>{t('pbPo')}: {String(invoice.buyer.po_reference)}</div> : null}
              </div>
            </div>
            <div className="table-wrap" style={{ marginTop: 14 }}>
              <table className="table">
                <thead><tr><th>{t('p8Description')}</th><th>{t('p8Qty')}</th><th>{t('p8Unit')}</th><th>{t('p8Net')}</th><th>{t('p8Vat')}</th><th>{t('p8Total')}</th></tr></thead>
                <tbody>
                  {invoice.lines.map(l => (
                    <tr key={l.lineNo}>
                      <td>{l.description}</td><td>{l.quantity}</td><td>{formatSar(l.unitHalala, lang)}</td><td>{formatSar(l.netHalala, lang)}</td>
                      <td>{formatSar(l.vatHalala, lang)} ({(l.vatRateBp / 100).toFixed(2)}%)</td><td>{formatSar(l.totalHalala, lang)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="inset small" style={{ marginTop: 14 }}>
              <div className="between"><span className="muted">{t('p8Net')}</span><strong>{formatSar(invoice.netHalala, lang)}</strong></div>
              <div className="between"><span className="muted">{t('p8Vat')}</span><strong>{formatSar(invoice.vatHalala, lang)}</strong></div>
              <div className="between"><span>{t('p8Total')}</span><strong>{formatSar(invoice.totalHalala, lang)}</strong></div>
              <div className="between"><span className="muted">{t('p8Paid')}</span><strong>{formatSar(invoice.amountPaidHalala, lang)}</strong></div>
              <div className="between"><span className="muted">{t('p8Balance')}</span><strong>{formatSar(invoice.totalHalala - invoice.amountPaidHalala, lang)}</strong></div>
              <div className="between"><span className="muted">{t('p8InvoiceStatus')}</span><span className="pill pill-neutral">{t(`p8Inv_${invoice.status}`)}</span></div>
            </div>
            {invoice.icv !== null && <p className="muted small" style={{ marginTop: 10, wordBreak: 'break-all' }}>{t('p8IntegrityChain')}: ICV {invoice.icv} · <span dir="ltr">{invoice.invoiceHash}</span></p>}
            <p className="muted small">{t('p8ZatcaNotice')}</p>
          </article>
        </>
      )}
    </>
  );
}
