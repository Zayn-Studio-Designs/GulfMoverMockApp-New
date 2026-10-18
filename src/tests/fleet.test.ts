import { describe, expect, test } from 'vitest';
import { BRIEF_TIMES, TIME_SLOTS, boatAvailability, canBookPassengers, canCharter, formatTime, type BoatSlot } from '../domain/fleet';

const slot = (over: Partial<BoatSlot>): BoatSlot => ({ id: 'x', boatId: 'B-01', date: '2026-10-20', time: '07:00', kind: 'scheduled', passengers: 2, refs: [], holder: '', status: '', ...over });

describe('time slots', () => {
  test('every hour of the day plus the brief 09:30 departure', () => {
    expect(TIME_SLOTS).toHaveLength(25);
    expect(TIME_SLOTS[0]).toBe('00:00');
    expect(TIME_SLOTS[TIME_SLOTS.length - 1]).toBe('23:00');
    for (const t of BRIEF_TIMES) expect(TIME_SLOTS).toContain(t);
  });
  test('12-hour format in English and Arabic', () => {
    expect(formatTime('00:00')).toBe('12:00 AM');
    expect(formatTime('09:30')).toBe('9:30 AM');
    expect(formatTime('12:00')).toBe('12:00 PM');
    expect(formatTime('13:00')).toBe('1:00 PM');
    expect(formatTime('23:00', 'ar')).toBe('11:00 م');
    expect(formatTime('07:00', 'ar')).toBe('7:00 ص');
  });
});

describe('boat availability', () => {
  const slots = [slot({}), slot({ boatId: 'B-02', kind: 'charter' })];
  test('free boat: passengers and charters allowed', () => {
    const av = boatAvailability(slots, 'B-03', '2026-10-20', '07:00');
    expect(av).toBe('free');
    expect(canBookPassengers(av)).toBe(true);
    expect(canCharter(av)).toBe(true);
  });
  test('shared sailing: more passengers may join, but it cannot be chartered', () => {
    const av = boatAvailability(slots, 'B-01', '2026-10-20', '07:00');
    expect(av).toBe('shared');
    expect(canBookPassengers(av)).toBe(true);
    expect(canCharter(av)).toBe(false);
  });
  test('chartered boat is taken for everyone else', () => {
    const av = boatAvailability(slots, 'B-02', '2026-10-20', '07:00');
    expect(av).toBe('chartered');
    expect(canBookPassengers(av)).toBe(false);
    expect(canCharter(av)).toBe(false);
  });
  test('the same boat at another time is unaffected', () => {
    expect(boatAvailability(slots, 'B-02', '2026-10-20', '08:00')).toBe('free');
  });
});
