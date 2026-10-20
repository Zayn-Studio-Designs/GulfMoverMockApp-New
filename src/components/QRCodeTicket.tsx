import { useMemo } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { ticketScanPayload } from '../domain/tickets';

/**
 * A genuine, scannable QR image encoding only the opaque ticket verification
 * reference — never passenger names, phone numbers, identity numbers or
 * payment details. Rendered as SVG so it stays crisp at phone size.
 */
export function QRCodeTicket({ ticketId, size = 168, className }: { ticketId: string; size?: number; className?: string }) {
  const value = useMemo(() => ticketScanPayload(ticketId), [ticketId]);
  return (
    <div className={`qr-code${className ? ` ${className}` : ''}`} role="img" aria-label={`Scannable QR verification code ${ticketId}`}>
      <QRCodeSVG value={value} size={size} level="M" marginSize={2} aria-hidden="true" data-testid="qr-svg" />
      <span className="tiny muted mono qr-payload" dir="ltr">{value}</span>
    </div>
  );
}
