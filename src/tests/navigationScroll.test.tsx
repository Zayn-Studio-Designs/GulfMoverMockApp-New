// Regression tests for 0-3: moving through the booking steps starts each step at the top of the
// page, and opening a booking's details brings the details panel into view.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';

async function renderApp(path: string) {
  render(<AppProviders><MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter></AppProviders>);
  fireEvent.click(screen.getByRole('button', { name: 'Explore as demo guest' }));
  await screen.findAllByRole('navigation', { name: 'Main navigation' });
}

let scrollTo: ReturnType<typeof vi.fn>;
let scrollIntoView: ReturnType<typeof vi.fn>;
const original = { scrollTo: window.scrollTo, scrollIntoView: Element.prototype.scrollIntoView };

beforeEach(() => {
  localStorage.clear();
  scrollTo = vi.fn();
  scrollIntoView = vi.fn();
  window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
  Element.prototype.scrollIntoView = scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
});
afterEach(() => {
  window.scrollTo = original.scrollTo;
  Element.prototype.scrollIntoView = original.scrollIntoView;
});

const toTop = () => scrollTo.mock.calls.filter(([arg]) => typeof arg === 'object' && arg.top === 0);

describe('booking steps start at the top of the page', () => {
  test('Continue and Back each jump to the top, without a slow smooth glide', async () => {
    await renderApp('/book');
    expect(await screen.findByRole('heading', { level: 1, name: 'Book a marine transfer' })).toBeInTheDocument();
    scrollTo.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Continue/ }));
    expect(await screen.findByText('Choose the journey')).toBeInTheDocument();
    expect(toTop()).toHaveLength(1);
    expect(toTop()[0][0]).toMatchObject({ top: 0, behavior: 'instant' });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(toTop()).toHaveLength(2);
  });

  test('changing page from the menu also jumps to the top', async () => {
    await renderApp('/');
    scrollTo.mockClear();
    const nav = screen.getAllByRole('navigation', { name: 'Main navigation' })[0];
    fireEvent.click(within(nav).getByRole('link', { name: 'My Bookings' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'My bookings' })).toBeInTheDocument();
    expect(toTop()[0][0]).toMatchObject({ top: 0, behavior: 'instant' });
  });
});

describe('details panels come into view when opened', () => {
  test('View details on My Bookings brings the panel into view if it opens out of sight', async () => {
    await renderApp('/bookings');
    // jsdom has no layout: report the panel as below the visible screen.
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: 2000, bottom: 2400, left: 0, right: 300, width: 300, height: 400, x: 0, y: 2000, toJSON: () => ({}) } as DOMRect);
    try {
      const card = screen.getByText('GM-DEMO-0248').closest('.booking-card') as HTMLElement;
      fireEvent.click(within(card).getByRole('button', { name: 'View details' }));
      expect(await screen.findByText('BOOKING DETAIL / DEMO')).toBeInTheDocument();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    } finally { rect.mockRestore(); }
  });
});

describe('a blocked Continue on the details step is never silent', () => {
  test('the message is brought into view and the cursor goes to the first missing field', async () => {
    await renderApp('/book');
    fireEvent.click(screen.getByRole('button', { name: /^Continue/ }));
    expect(await screen.findByText('Choose the journey')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Continue/ }));
    expect(await screen.findByLabelText(/Full name/)).toBeInTheDocument();
    scrollIntoView.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Continue/ }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await new Promise(r => requestAnimationFrame(() => r(null)));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(document.activeElement?.id).toBe('passenger-name');
  });
});
