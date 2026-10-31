import { fireEvent, screen } from '@testing-library/react';

/** Ticks the sign-in screen's "I am 18 or older" confirmation (no-op if already ticked). */
export function confirmAge(): void {
  const box = screen.getByRole('checkbox', { name: /18 years of age or older/i }) as HTMLInputElement;
  if (!box.checked) fireEvent.click(box);
}

/** Fills the sign-up date of birth with an adult date (no-op if already filled). */
export function enterAdultDob(value = '1990-05-01'): void {
  const field = screen.getByLabelText('Date of birth') as HTMLInputElement;
  if (!field.value) fireEvent.change(field, { target: { value } });
}
