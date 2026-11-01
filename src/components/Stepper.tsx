import { useLanguage } from '../context/LanguageContext';

/**
 * Phase 22 shared numeric stepper (HIG steppers): two-segment −/+ control next
 * to a labeled value. Native buttons = keyboard + screen-reader support.
 * `value` may be null (unset); minus at `min` clears to null when `onClear`
 * is provided, plus from null starts at `min`.
 */
export function Stepper({ id, value, min, max, onChange, disabled, labelledBy }: {
  id?: string; value: number | null; min: number; max: number;
  onChange: (next: number | null) => void; disabled?: boolean; labelledBy?: string;
}) {
  const { t } = useLanguage();
  const decDisabled = disabled || value === null || value <= min;
  const incDisabled = disabled || (value !== null && value >= max);
  const dec = () => { if (value !== null && value > min) onChange(value - 1); };
  const inc = () => onChange(value === null ? min : Math.min(max, value + 1));
  return (
    <div className="num-stepper" id={id} role="group" aria-labelledby={labelledBy}>
      <button type="button" aria-label={t('stepDecrease')}
        disabled={decDisabled} onClick={dec}>−</button>
      <output className="num-value mono" aria-live="polite">
        {value === null ? <span className="num-unset">–</span> : value}
      </output>
      <button type="button" aria-label={t('stepIncrease')}
        disabled={incDisabled} onClick={inc}>+</button>
    </div>
  );
}
