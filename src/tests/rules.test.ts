import { describe, expect, test } from 'vitest';
import { eligibleTickets, fareTotal, isMinimumMet, legCount, pillTone, thresholdLabel } from '../domain/rules';

describe('fare (SAR 500 per passenger per one-way leg)', () => {
  test('one passenger, outbound only', () => expect(fareTotal(1, false)).toBe(500));
  test('three passengers, outbound only', () => expect(fareTotal(3, false)).toBe(1500));
  test('a return leg is a second one-way leg', () => {
    expect(legCount(true)).toBe(2);
    expect(fareTotal(2, true)).toBe(2000);
  });
  test('passenger count never drops below one', () => expect(fareTotal(0, false)).toBe(500));
});

describe('minimum sailing (four tickets across all bookings on a sailing)', () => {
  test('a single booking of one ticket does not meet the minimum', () => {
    expect(isMinimumMet(eligibleTickets([1]))).toBe(false);
  });
  test('several small bookings together meet the minimum', () => {
    expect(isMinimumMet(eligibleTickets([1, 2, 1]))).toBe(true);
    expect(thresholdLabel(eligibleTickets([1, 2, 1]))).toBe('Minimum met (demo)');
  });
  test('three tickets across bookings are still collecting', () => {
    expect(thresholdLabel(eligibleTickets([2, 1]))).toBe('Collecting bookings');
  });
});

describe('status tone always derives from the text', () => {
  test.each([
    ['Payment recorded (demo)', 'pill-green'],
    ['Payment pending (demo)', 'pill-gold'],
    ['Awaiting ATCO decision', 'pill-gold'],
    ['Suspended (demo)', 'pill-red'],
    ['Rejected (demo)', 'pill-red'],
  ])('%s → %s', (text, tone) => expect(pillTone(text)).toBe(tone));
});
