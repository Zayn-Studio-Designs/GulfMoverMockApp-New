// @vitest-environment node
//
// Phase 6, section 4.J: earlier phases verified the boarding *rules* but never proved that a real,
// rendered QR image can be read back, nor that the value a decoder extracts is the value the
// server accepts. This suite closes that gap with a real image and an independent decoder — no
// mocked `BarcodeDetector`, no re-encoded "comparison".
//
// Pipeline, exactly as production renders it:
//   get_ticket_qr (server-only secret) -> qrcode.react QRCodeSVG (the encoder ProductionTickets
//   uses) -> a real PNG screenshotted from a real browser -> an external, independent decoder
//   -> board_ticket (the trusted server validation, called with the value taken from the IMAGE).
//
// The decoder comes from the developer's machine because no QR decoder is bundled with the project
// and Chromium's own `BarcodeDetector` is absent in this environment (recorded in
// docs/backend/phase6-verification-hardening.md):
//
//   GM_QR_DECODER='swift /path/to/decode.swift'   # macOS Vision; any "cmd <png>" decoder works
//
// Without GM_QR_DECODER the image assertions are skipped with an explicit reason, never silently
// passed, and the payload that reaches boarding is the server value rather than the image value.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QRCodeSVG } from 'qrcode.react';
import { chromium } from 'playwright';
import { beforeAll, describe, expect, it } from 'vitest';
import { validTicketLookup } from '../../lib/ticketService';
import { confirmedUser, futureIso, grantPlatformRole, localStackConfigured, type TestUser } from './helpers';

const decoderParts = (process.env.GM_QR_DECODER ?? '').trim().split(/\s+/).filter(Boolean);
const suite = localStackConfigured ? describe : describe.skip;
/** Image-decode assertions run only where the developer supplied a decoder. */
const itWithDecoder = decoderParts.length ? it : it.skip;
const UNKNOWN_QR = `GMT1:${'0'.repeat(64)}`;
const dir = mkdtempSync(join(tmpdir(), 'gm-qr-'));

/** Renders `payload` with the app's own encoder in a real browser and returns the decoder's lines. */
async function renderAndDecode(payload: string, name: string): Promise<string[]> {
  const svg = renderToStaticMarkup(createElement(QRCodeSVG, {
    value: payload, size: 512, level: 'M', marginSize: 4, bgColor: '#ffffff', fgColor: '#000000',
  }));
  expect(svg.startsWith('<svg')).toBe(true);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 700, height: 700 } });
    await page.setContent(`<body style="margin:0;background:#fff">${svg}</body>`);
    const png = join(dir, `${name}.png`);
    await page.locator('svg').first().screenshot({ path: png });
    const output = execFileSync(decoderParts[0], [...decoderParts.slice(1), png], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return output.split('\n').map(line => line.trim()).filter(Boolean);
  } finally {
    await browser.close();
  }
}

suite('Phase 6: a rendered ticket QR image is decodable, and its payload boards', () => {
  let ops: TestUser; let owner: TestUser; let boarding: TestUser;
  let sailingId = ''; let ticketId = ''; let qr = ''; let bookingReference = ''; let passengerName = '';
  /** Value read out of the rendered image; used for the boarding assertions when a decoder exists. */
  let fromImage = '';

  beforeAll(async () => {
    ops = await confirmedUser('p6qr-ops'); owner = await confirmedUser('p6qr-owner');
    boarding = await confirmedUser('p6qr-boarding');
    grantPlatformRole(ops.id, 'operations'); grantPlatformRole(boarding.id, 'boarding_staff');
    const reviewer = await confirmedUser('p6qr-reviewer'); grantPlatformRole(reviewer.id, 'super_admin');
    const reg = await owner.client.rpc('register_company', {
      p_registration_key: randomUUID(), p_legal_name: `P6 QR company ${randomUUID()}`,
      p_profile_display_name: 'Fictional Owner',
    });
    expect(reg.error).toBeNull();
    const orgId = reg.data[0].id;
    expect((await reviewer.client.rpc('review_company', { p_organization_id: orgId, p_decision: 'approve' })).error).toBeNull();
    const vessel = await ops.client.from('vessels').insert({ name: `P6 QR vessel ${randomUUID()}`, passenger_capacity: 4 }).select('id').single();
    const route = await ops.client.from('routes').insert({ origin: `P6 QR pier ${randomUUID()}`, destination: 'Fictional anchorage' }).select('id').single();
    expect(vessel.error).toBeNull(); expect(route.error).toBeNull();
    const sailing = await ops.client.from('sailings')
      .insert({ vessel_id: vessel.data!.id, route_id: route.data!.id, departs_at: futureIso(72), seat_capacity: 4 })
      .select('id').single();
    expect(sailing.error).toBeNull(); sailingId = sailing.data!.id;
    const booked = await owner.client.rpc('create_booking', {
      p_request_key: randomUUID(), p_organization_id: orgId, p_outbound_sailing_id: sailingId,
      p_passenger_count: 1, p_contact_name: 'Fictional Passenger',
      p_contact_email: 'fiction@example.test', p_contact_phone: '+966130000000',
    });
    expect(booked.error).toBeNull();
    const bookingId: string = booked.data[0].booking_id;
    bookingReference = booked.data[0].reference;
    const tickets = await owner.client.from('tickets').select('id,reference,passenger_name').eq('booking_id', bookingId);
    expect(tickets.error).toBeNull(); expect(tickets.data).toHaveLength(1);
    ticketId = tickets.data![0].id;
    passengerName = tickets.data![0].passenger_name ?? '';
    const secret = await owner.client.rpc('get_ticket_qr', { p_ticket_id: ticketId });
    expect(secret.error).toBeNull(); qr = secret.data;
    expect((await ops.client.rpc('set_sailing_readiness', {
      p_sailing_id: sailingId, p_status: 'ready', p_reason: 'Phase 6 QR decode exercise',
    })).error).toBeNull();
  }, 90_000);

  itWithDecoder('an independent decoder reads the rendered image back as exactly the server secret, and nothing else', async () => {
    const decoded = await renderAndDecode(qr, 'ticket-qr');
    fromImage = decoded.find(line => line.startsWith('GMT1:')) ?? '';
    expect(decoded.filter(line => line.startsWith('GMT1:'))).toEqual([qr]);
    expect(fromImage).toMatch(/^GMT1:[0-9a-f]{64}$/);
    // The image carries the opaque verification reference only: no passenger name, no booking
    // reference, no e-mail, no database id.
    for (const line of decoded) {
      expect(line).not.toContain(passengerName || '\u0000');
      expect(line).not.toContain(bookingReference);
      expect(line).not.toContain('@');
      expect(line).not.toContain(ticketId);
    }
  }, 90_000);

  it('the value that boards is the value read from the image, exactly once', async () => {
    const scan = (code: string) => boarding.client.rpc('board_ticket', { p_code: code, p_sailing_id: sailingId });
    const code = decoderParts.length ? fromImage : qr;
    expect(validTicketLookup(code)).toBe(true);
    expect((await scan(code)).data).toBe('boarded');
    // Single use: the same image cannot board the same ticket again.
    expect((await scan(code)).data).toBe('already_boarded');
    expect((await scan(qr)).data).toBe('already_boarded');
  });

  it('a forged or tampered payload is refused by the server, and malformed values never leave the client', async () => {
    // A one-character change to the real secret: well-formed, so it reaches the server and is still
    // refused. The previous phase only proved this for a code that never existed.
    const tampered = `${qr.slice(0, 5)}${qr[5] === 'a' ? 'b' : 'a'}${qr.slice(6)}`;
    expect(tampered).not.toBe(qr);
    expect(validTicketLookup(tampered)).toBe(true);
    expect((await boarding.client.rpc('board_ticket', { p_code: tampered, p_sailing_id: sailingId })).data).toBe('not_found');
    expect((await boarding.client.rpc('board_ticket', { p_code: UNKNOWN_QR, p_sailing_id: sailingId })).data).toBe('not_found');
    // The demo-mode payload format is not a boarding credential for a real ticket: the server
    // finds no match instead of treating a client-side format as authority.
    const demo = await boarding.client.rpc('board_ticket', { p_code: 'GM-VERIFY-1|GMTK-ABC123', p_sailing_id: sailingId });
    expect(demo.error).toBeNull(); expect(demo.data).toBe('not_found');
    for (const bad of [`GMT1:${'z'.repeat(64)}`, `GMT1:${'0'.repeat(62)}`, 'GMT1:', ' ']) {
      expect(validTicketLookup(bad)).toBe(false);
    }
  });
});
