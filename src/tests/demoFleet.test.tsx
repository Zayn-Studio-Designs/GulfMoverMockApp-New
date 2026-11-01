import { beforeEach, describe, expect, test } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';
import { confirmAge } from './ageGate';
import { initialDemoBoats, nextBoatId } from '../context/DemoContext';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dir = 'ltr';
  document.documentElement.lang = 'en';
});

/** Opens the app at `path` signed in as the built-in demo guest. */
async function renderApp(path = '/') {
  const view = render(
    <AppProviders>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );
  // On a remount the persisted session is already signed in, so the age gate may be absent.
  if (screen.queryByRole('checkbox', { name: /18 years of age or older/i })) confirmAge();
  // The demo session persists in localStorage, so a remount in the same test is already signed in.
  const guest = screen.queryByRole('button', { name: 'Explore as demo guest' });
  if (guest) fireEvent.click(guest);
  await screen.findAllByRole('navigation', { name: 'Main navigation' });
  return view;
}

const activeRows = () => screen.getAllByRole('button', { name: 'Edit boat' });

function retireFirstActive() {
  fireEvent.click(screen.getAllByRole('button', { name: 'Retire boat' })[0]);
  fireEvent.change(screen.getByLabelText('Reason / notes'), { target: { value: 'no longer needed' } });
  const modal = document.querySelector('.modal-backdrop.open') as HTMLElement;
  fireEvent.click(within(modal).getByRole('button', { name: 'Retire boat' }));
}

describe('demo fleet management', () => {
  test('starts with the three preset boats', async () => {
    await renderApp('/fleet');
    expect(activeRows()).toHaveLength(3);
  });

  test('nextBoatId skips retired IDs and never repeats', () => {
    expect(nextBoatId(initialDemoBoats())).toBe('B-04');
    expect(nextBoatId([...initialDemoBoats(), { id: 'B-04', name: { en: 'X', ar: 'X' }, status: 'retired' as const }])).toBe('B-05');
  });

  test('retire removes from the active fleet but keeps history; last boat is protected', async () => {
    await renderApp('/fleet');
    retireFirstActive();
    expect(activeRows()).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Retired vessels' })).toBeTruthy();
    retireFirstActive();
    expect(activeRows()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Retire boat' })).toBeDisabled();
    // Retired boats stay visible in the booking history table by name.
    expect(screen.getAllByText(/B-0/).length).toBeGreaterThan(0);
  });

  test('add validates, then grows the fleet; edit renames', async () => {
    await renderApp('/fleet');
    fireEvent.click(screen.getByRole('button', { name: 'Add boat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByRole('alert').textContent).toMatch(/boat name/i);
    fireEvent.change(screen.getByLabelText(/Boat name \(English\)/), { target: { value: 'Harbor Star' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(activeRows()).toHaveLength(4);
    expect(screen.getAllByText('Harbor Star').length).toBeGreaterThan(0);
    // Duplicate names are refused.
    fireEvent.click(screen.getByRole('button', { name: 'Add boat' }));
    fireEvent.change(screen.getByLabelText(/Boat name \(English\)/), { target: { value: 'harbor star' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByRole('alert').textContent).toMatch(/already exists/i);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    // Edit renames the first boat.
    fireEvent.click(activeRows()[0]);
    fireEvent.change(screen.getByLabelText(/Boat name \(English\)/), { target: { value: 'Renamed One' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getAllByText('Renamed One').length).toBeGreaterThan(0);
  });

  test('fleet changes persist across reload; reset restores the three presets', async () => {
    const first = await renderApp('/fleet');
    retireFirstActive();
    fireEvent.click(screen.getByRole('button', { name: 'Add boat' }));
    fireEvent.change(screen.getByLabelText(/Boat name \(English\)/), { target: { value: 'Extra One' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(activeRows()).toHaveLength(3);
    first.unmount();
    await renderApp('/fleet');
    expect(activeRows()).toHaveLength(3);
    expect(screen.getAllByText('Extra One').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Reset demo data' }));
    expect(activeRows()).toHaveLength(3);
    expect(screen.queryByText('Extra One')).toBeNull();
  });
});
