import { beforeEach, describe, expect, test } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';
import { confirmAge } from './ageGate';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dir = 'ltr';
  document.documentElement.lang = 'en';
});

function renderInto(path = '/') {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('liquid glass default (Phase 26 rollout)', () => {
  test('no preview switch; glass stylesheet applied; fleet management works', async () => {
    renderInto('/fleet');
    // Signed out: no appearance switch exists anywhere.
    expect(screen.queryByRole('group', { name: 'Appearance preview' })).toBeNull();
    confirmAge();
    fireEvent.click(screen.getByRole('button', { name: 'Explore as demo guest' }));
    await screen.findAllByRole('navigation', { name: 'Main navigation' });
    // Phase 26: approved default — the temporary Current/Liquid Glass toggle is gone.
    expect(screen.queryByRole('button', { name: 'Liquid Glass' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Current' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Appearance preview' })).toBeNull();
    // Glass is the default: no opt-in class or switch is required for the chrome to render.
    // Phase 24 fleet management still works under the default design.
    fireEvent.click(screen.getByRole('button', { name: 'Add boat' }));
    fireEvent.change(screen.getByLabelText(/Boat name \(English\)/), { target: { value: 'Glass Boat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getAllByRole('button', { name: 'Edit boat' })).toHaveLength(4);
  });
});
