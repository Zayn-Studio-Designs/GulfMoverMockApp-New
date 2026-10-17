import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useDemo, type ServiceType, type PaymentChoice } from '../context/DemoContext';
import { useUi } from '../context/UiContext';
import { PageHeader } from '../components/PageHeader';
import { StatusPill } from '../components/StatusPill';
import { ArrowIcon, Icon, type IconName } from '../components/Icon';
import { DESTINATIONS, ORIGIN, today } from '../data/demoData';
import { DEPARTURE_TIMES, FARE_PER_PASSENGER_LEG, fareTotal, legCount, thresholdLabel } from '../domain/rules';

const SERVICES: ReadonlyArray<{ value: ServiceType; title: string; desc: string; icon: IconName }> = [
  { value: 'passenger', title: 'servicePassenger', desc: 'servicePassengerDesc', icon: 'user' },
  { value: 'material', title: 'serviceMaterial', desc: 'serviceMaterialDesc', icon: 'box' },
  { value: 'combined', title: 'serviceCombined', desc: 'serviceCombinedDesc', icon: 'list' },
  { value: 'charter', title: 'serviceCharter', desc: 'serviceCharterDesc', icon: 'ship' },
];

const SERVICE_LABEL: Record<ServiceType, string> = {
  passenger: 'Passenger transfer', material: 'Material request', combined: 'Combined request', charter: 'Charter inquiry',
};

function Stepper({ step }: { step: number }) {
  const { t } = useLanguage();
  const names = [t('stepService'), t('stepSearch'), t('stepDetails'), t('stepReview'), t('stepResult')];
  return (
    <ol className="stepper">
      {names.map((n, i) => (
        <li key={n} className={`step${step === i + 1 ? ' active' : ''}${step > i + 1 ? ' done' : ''}`}>
          <span className="step-num">{step > i + 1 ? '✓' : i + 1}</span><span>{n}</span>
        </li>
      ))}
    </ol>
  );
}

function ServiceStep() {
  const { t } = useLanguage();
  const { wizard, updateWizard, addAudit } = useDemo();
  const { openModal, toast } = useUi();

  const next = () => {
    if (wizard.service === 'charter') {
      openModal({
        title: t('serviceCharter'), desc: t('serviceCharterDesc'), confirmText: t('confirm'), requireReason: false,
        onConfirm: () => { addAudit('Prototype', 'Charter inquiry created (demo)'); toast(t('inquiryCreated')); },
      });
      return;
    }
    updateWizard({ bookStep: 2 });
  };

  return (
    <div className="card card-pad">
      <div className="between">
        <div><h2 className="card-title">{t('serviceTitle')}</h2><p className="card-desc">{t('homeCopy')}</p></div>
        <span className="pill pill-blue">{t('stepService')} 1/5</span>
      </div>
      <div className="grid grid-2" style={{ marginTop: 18 }}>
        {SERVICES.map(s => (
          <button key={s.value} type="button" aria-pressed={wizard.service === s.value}
            className={`service-card${wizard.service === s.value ? ' selected' : ''}`}
            onClick={() => updateWizard({ service: s.value, bookStep: 1, formError: '' })}>
            <span className="service-icon"><Icon name={s.icon} /></span>
            <span><span className="service-name">{t(s.title)}</span><span className="service-desc">{t(s.desc)}</span></span>
          </button>
        ))}
      </div>
      {wizard.service === 'charter' && (
        <div className="notice warn" style={{ marginTop: 15 }}><strong>{t('serviceCharter')}</strong>{t('serviceCharterDesc')}</div>
      )}
      <div className="between" style={{ marginTop: 20 }}>
        <span className="small muted">{t('briefFare')}: <strong>SAR 500</strong> {t('perTrip')}</span>
        <button type="button" className="btn btn-primary" onClick={next}>{t('continue')} <ArrowIcon /></button>
      </div>
    </div>
  );
}

function SailingChoices({ leg }: { leg: 'outbound' | 'return' }) {
  const { t, tx, lang } = useLanguage();
  const { wizard, updateWizard, sailings } = useDemo();
  const current = leg === 'return' ? wizard.selectedRet : wizard.selectedOut;
  return (
    <div style={{ marginTop: 15 }}>
      <div className="between" style={{ marginBottom: 9 }}>
        <strong className="card-title">{leg === 'return' ? t('returnSailing') : t('departure')}</strong>
        <span className="tiny muted">{t('demoAvailability')}</span>
      </div>
      {DEPARTURE_TIMES.map(time => {
        const sailing = sailings.find(s => s.time === time);
        const count = sailing?.count ?? 0;
        const selected = current === time;
        return (
          <button key={time} type="button" aria-pressed={selected} className={`sailing-option${selected ? ' selected' : ''}`}
            onClick={() => updateWizard(leg === 'return' ? { selectedRet: time } : { selectedOut: time })}>
            <span className={`radio${selected ? ' on' : ''}`} />
            <span className="time-cell"><span className="time-big mono">{time}</span><br />
              <span className="route-small">{tx(leg === 'return' ? 'Return (demo)' : 'Departure (demo)')}</span></span>
            <span className="route-cell"><span className="route-badge">{tx(sailing?.dest ?? DESTINATIONS[0])}</span><br />
              <span className="route-small">{t('demoAvailability')}: {count >= 4 ? tx('4+ eligible tickets (demo)') : t('ticketsOfMin').replace('{n}', String(count))}</span></span>
            <span className="fare-cell"><span className="fare">SAR {FARE_PER_PASSENGER_LEG}</span><br /><span className="fare-note">{t('perPassenger')}</span></span>
            <span className="select-cell">{selected ? <StatusPill text={lang === 'ar' ? 'محدد' : 'Selected'} /> : <span className="route-badge">{tx('Select')}</span>}</span>
          </button>
        );
      })}
    </div>
  );
}

function JourneyStep() {
  const { t, tx } = useLanguage();
  const { wizard, updateWizard } = useDemo();
  const { toast } = useUi();

  const next = () => {
    if (!wizard.journeyDate) { toast(t('chooseDate')); return; }
    if (wizard.addReturn) {
      if (!wizard.returnDate) { toast(t('chooseReturnDate')); return; }
      if (wizard.returnDate < wizard.journeyDate) { toast(t('returnAfter')); return; }
    }
    updateWizard({ bookStep: 3 });
  };

  return (
    <div className="card card-pad">
      <div className="between">
        <div><h2 className="card-title">{t('journeyTitle')}</h2><p className="card-desc">{t('journeySub')}</p></div>
        <StatusPill text={t('demoOnly')} />
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="journey-date">{t('departureDate')} *</label>
          <input id="journey-date" type="date" value={wizard.journeyDate} min={today()} onChange={e => updateWizard({ journeyDate: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="dest-select">{t('destination')} *</label>
          <select id="dest-select" value={wizard.chosenDestination} onChange={e => updateWizard({ chosenDestination: e.target.value })}>
            {DESTINATIONS.map(d => <option key={d} value={d}>{tx(d)}</option>)}
          </select>
          <small>{t('capacityNotSet')}</small>
        </div>
        <div className="field">
          <label htmlFor="pax-count">{t('passengers')} *</label>
          <select id="pax-count" value={wizard.paxCount} onChange={e => updateWizard({ paxCount: Number(e.target.value) || 1 })}>
            {[1, 2, 3, 4, 5, 6, 7, 8].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div className="field">
          <label>{t('direction')}</label>
          <div className="inset row"><span className="pill pill-blue">{t('outbound')}</span><span className="small muted">{tx(ORIGIN)}</span></div>
        </div>
      </div>
      <SailingChoices leg="outbound" />
      <div className="divider" />
      <label className="switch">
        <input type="checkbox" id="return-toggle" checked={wizard.addReturn} onChange={e => updateWizard({ addReturn: e.target.checked })} />
        <span>{t('returnToggle')}</span>
      </label>
      {wizard.addReturn ? (
        <>
          <div className="form-grid" style={{ marginTop: 13 }}>
            <div className="field">
              <label htmlFor="return-date">{t('returnDate')} *</label>
              <input type="date" id="return-date" value={wizard.returnDate} min={today()} onChange={e => updateWizard({ returnDate: e.target.value })} />
            </div>
            <div className="field"><label>{t('destination')}</label><div className="inset">{tx(wizard.chosenDestination)}</div></div>
          </div>
          <SailingChoices leg="return" />
        </>
      ) : <p className="card-desc" style={{ marginTop: 10 }}>{t('returnHint')}</p>}
      {(wizard.service === 'material' || wizard.service === 'combined') && (
        <div className="notice warn" style={{ marginTop: 16 }}><strong>{t('materialPending')}</strong>{t('serviceMaterialDesc')} {t('capacityNotSet')}</div>
      )}
      <div className="between" style={{ marginTop: 20 }}>
        <button type="button" className="btn btn-outline" onClick={() => updateWizard({ bookStep: 1 })}>{t('back')}</button>
        <button type="button" className="btn btn-primary" onClick={next}>{t('continue')} <ArrowIcon /></button>
      </div>
      <p className="footer-note">{t('fareFormula')}. {t('vatPending')}.</p>
    </div>
  );
}

function DetailsStep() {
  const { t } = useLanguage();
  const { wizard, updateWizard } = useDemo();

  const next = () => {
    const name = wizard.passengerName.trim(), email = wizard.passengerEmail.trim(), phone = wizard.passengerPhone.trim();
    if (!name || !email || !phone) { updateWizard({ formError: 'completeFields' }); return; }
    if (!email.includes('@')) { updateWizard({ formError: 'validEmail' }); return; }
    updateWizard({ formError: '', bookStep: 4 });
  };

  const field = (id: string, labelKey: string, key: 'passengerName' | 'passengerEmail' | 'passengerPhone' | 'passengerCompany' | 'vessel' | 'imo',
    opts: { required?: boolean; type?: string; autoComplete?: string; placeholder: string; hint?: string }) => (
    <div className="field">
      <label htmlFor={id}>{t(labelKey)}{opts.required ? ' *' : ''}</label>
      <input id={id} type={opts.type ?? 'text'} autoComplete={opts.autoComplete} placeholder={opts.placeholder}
        required={opts.required} value={wizard[key]} onChange={e => updateWizard({ [key]: e.target.value })} />
      {opts.hint && <small>{opts.hint}</small>}
    </div>
  );

  return (
    <div className="card card-pad">
      <div className="between">
        <div><h2 className="card-title">{t('detailsTitle')}</h2><p className="card-desc">{t('detailsSub')}</p></div>
        <span className="pill pill-neutral">{t('stepDetails')} 3/5</span>
      </div>
      {wizard.formError && <div className="notice danger" role="alert" style={{ marginTop: 15 }}>{t(wizard.formError)}</div>}
      <div className="form-grid" style={{ marginTop: 17 }}>
        {field('passenger-name', 'fullName', 'passengerName', { required: true, autoComplete: 'name', placeholder: 'Demo Passenger' })}
        {field('passenger-email', 'email', 'passengerEmail', { required: true, type: 'email', autoComplete: 'email', placeholder: 'passenger@example.test' })}
        {field('passenger-phone', 'phone', 'passengerPhone', { required: true, type: 'tel', autoComplete: 'tel', placeholder: '+966 5X XXX XXXX' })}
        {field('passenger-company', 'company', 'passengerCompany', { placeholder: 'Demo Logistics Co.', hint: t('fieldOptional') })}
        {field('vessel-field', 'vessel', 'vessel', { placeholder: 'Offshore Vessel Demo-01' })}
        {field('imo-field', 'imo', 'imo', { placeholder: 'Demo reference only' })}
      </div>
      <div className="notice" style={{ marginTop: 17 }}><strong>{t('noSensitive')}</strong>{t('detailsSub')}</div>
      <div className="between" style={{ marginTop: 20 }}>
        <button type="button" className="btn btn-outline" onClick={() => updateWizard({ bookStep: 2 })}>{t('back')}</button>
        <button type="button" className="btn btn-primary" onClick={next}>{t('continue')} <ArrowIcon /></button>
      </div>
    </div>
  );
}

function ReviewStep() {
  const { t, tx } = useLanguage();
  const { wizard, updateWizard, materials, addMaterial, addAudit } = useDemo();
  const { toast } = useUi();
  const navigate = useNavigate();
  const pax = Math.max(1, wizard.paxCount);
  const materialOnly = wizard.service === 'material';
  const total = materialOnly ? 0 : fareTotal(pax, wizard.addReturn);
  const legLine = (labelKey: string, date: string, time: string) => (
    <>
      <div className="between"><strong>{t(labelKey)}</strong><StatusPill text="DEMO DATA" /></div>
      <p className="small muted">{date} · <b className="mono">{time}</b> · {tx(wizard.chosenDestination)}</p>
      <div className="between"><span>{pax} × {t('perPassenger')}</span><strong>SAR {pax * FARE_PER_PASSENGER_LEG}</strong></div>
    </>
  );

  const next = () => {
    if (!wizard.policyAck || !wizard.accessAck) { toast(t('ackFirst')); return; }
    if (materialOnly) {
      const id = `MR-DEMO-${String(materials.length + 1).padStart(2, '0')}`;
      addMaterial({ id, name: 'New material request (demo)', qty: 'To be reviewed', weight: 'Not provided', size: 'Not provided', status: 'Pending review',
        sender: wizard.passengerCompany || 'Demo requestor', receiver: wizard.chosenDestination,
        detail: 'Submitted through the offline UI prototype only. No actual transport acceptance or charge.' });
      addAudit('Prototype', `${id} submitted for review (demo)`);
      navigate('/materials');
      toast(t('materialPending'));
      return;
    }
    updateWizard({ bookStep: 5, paymentChoice: '' });
  };

  return (
    <div className="split">
      <div className="card card-pad">
        <div className="between">
          <div><h2 className="card-title">{t('reviewTitle')}</h2><p className="card-desc">{t('reviewSub')}</p></div>
          <span className="pill pill-blue">{t('stepReview')} 4/5</span>
        </div>
        <div className="divider" />
        {legLine('outboundLeg', wizard.journeyDate, wizard.selectedOut)}
        {wizard.addReturn && <><div className="divider" />{legLine('returnLeg', wizard.returnDate, wizard.selectedRet)}</>}
        <div className="divider" />
        <div className="price-line"><span>{t('subtotal')}</span><strong>SAR {total.toLocaleString('en-US')}</strong></div>
        <div className="price-line"><span>{t('vat')}</span><strong>{t('vatPending')}</strong></div>
        <div className="price-line price-total"><span>{t('total')}</span>
          <strong>{materialOnly ? t('materialNoPayment') : `SAR ${total.toLocaleString('en-US')} + ${tx('VAT/approved charges TBD')}`}</strong></div>
        <p className="footer-note">{materialOnly ? t('materialNoTariff') : t('fareFormula')}</p>
        <div className="divider" />
        <h3 className="card-title" style={{ marginBottom: 9 }}>{t('policyTitle')}</h3>
        <div className="notice warn"><strong>{t('policyDemo')}</strong>{t('ackAccess')}</div>
        <div className="grid" style={{ gap: 10, marginTop: 13 }}>
          <label className="checkrow"><input id="policy-ack" type="checkbox" checked={wizard.policyAck} onChange={e => updateWizard({ policyAck: e.target.checked })} /><span>{t('ackPolicy')}</span></label>
          <label className="checkrow"><input id="access-ack" type="checkbox" checked={wizard.accessAck} onChange={e => updateWizard({ accessAck: e.target.checked })} /><span>{t('ackAccess')}</span></label>
        </div>
        <div className="between" style={{ marginTop: 20 }}>
          <button type="button" className="btn btn-outline" onClick={() => updateWizard({ bookStep: 3 })}>{t('back')}</button>
          <button type="button" className="btn btn-primary" onClick={next}>{materialOnly ? t('materialSubmit') : t('simulatePayment')} <ArrowIcon /></button>
        </div>
      </div>
      <aside className="card card-pad">
        <div className="eyebrow">{t('safeTitle')}</div>
        <h3 className="card-title">{t('safeTitle')}</h3>
        <p className="card-desc">{t('safeCopy')}</p>
        <div className="divider" />
        <div className="between"><span className="small muted">{t('passengers')}</span><strong>{pax}</strong></div>
        <div className="between" style={{ marginTop: 9 }}><span className="small muted">{t('leg')}</span><strong>{t('legsSelected').replace('{n}', String(legCount(wizard.addReturn)))}</strong></div>
        <div className="divider" />
        <p className="small muted">{t('thresholdExplainer')}</p>
      </aside>
    </div>
  );
}

function PaymentStep() {
  const { t, tx } = useLanguage();
  const { wizard, updateWizard, bookings, sailings, addBooking, addMaterial, materials, addTicketsToSailing } = useDemo();
  const { toast } = useUi();
  const choices: ReadonlyArray<{ value: PaymentChoice; title: string; desc: string; icon: IconName }> = [
    { value: 'recorded', title: 'payRecorded', desc: 'Local demo state only.', icon: 'check' },
    { value: 'pending', title: 'payPending', desc: 'Shows an uncertain/pending payment.', icon: 'clock' },
    { value: 'failed', title: 'payFailed', desc: 'No payment is made.', icon: 'alert' },
  ];
  const feedback = wizard.paymentChoice === 'recorded' ? t('recorded') : wizard.paymentChoice === 'pending' ? t('pending') : tx('Payment failed / uncertain (demo)');

  const finish = () => {
    if (!wizard.paymentChoice) { toast(t('paymentNotice')); return; }
    const pax = Math.max(1, wizard.paxCount);
    // Minimum is aggregated across all bookings on the sailing, not per booking.
    const existing = sailings.find(s => s.time === wizard.selectedOut && s.dir === 'Outbound')?.count ?? 0;
    const booking = {
      ref: `GM-DEMO-${String(3200 + bookings.length + 1).padStart(4, '0')}`,
      date: wizard.journeyDate, leg: wizard.addReturn ? 'Outbound + return' : 'Outbound', time: wizard.selectedOut,
      dest: wizard.chosenDestination, passengers: pax, amount: fareTotal(pax, wizard.addReturn),
      payment: wizard.paymentChoice === 'recorded' ? 'Payment recorded (demo)' : wizard.paymentChoice === 'pending' ? 'Payment pending (demo)' : 'Payment failed / uncertain (demo)',
      threshold: thresholdLabel(existing + pax), ops: 'Awaiting ATCO decision', boarding: 'Not started',
      service: SERVICE_LABEL[wizard.service],
      return: wizard.addReturn ? { date: wizard.returnDate, time: wizard.selectedRet, dest: wizard.chosenDestination } : null,
    };
    addBooking(booking);
    addTicketsToSailing(wizard.selectedOut, pax);
    if (wizard.service !== 'passenger') {
      addMaterial({ id: `MR-DEMO-${String(materials.length + 1).padStart(2, '0')}`, name: 'New fictional material request', qty: 'To confirm',
        weight: 'Not provided', size: 'Not provided', status: 'Pending review', sender: 'Demo requestor', receiver: wizard.chosenDestination,
        detail: 'Created locally from the UI prototype; not submitted to an actual operator.' });
    }
    updateWizard({ bookStep: 6, currentBooking: booking });
  };

  return (
    <div className="card card-pad" style={{ maxWidth: 880, margin: '0 auto' }}>
      <div className="eyebrow">{t('stepResult')} / {tx('DEMO')}</div>
      <h2 className="card-title" style={{ fontSize: 24 }}>{t('paymentTitle')}</h2>
      <p className="card-desc">{t('paymentSub')}</p>
      <div className="notice warn" style={{ marginTop: 17 }}><strong>{t('demoOnly')}</strong>{t('paymentNotice')}</div>
      <div className="grid grid-3" style={{ marginTop: 20 }}>
        {choices.map(c => (
          <button key={c.value} type="button" aria-pressed={wizard.paymentChoice === c.value}
            className={`service-card${wizard.paymentChoice === c.value ? ' selected' : ''}`} onClick={() => updateWizard({ paymentChoice: c.value })}>
            <span className="service-icon"><Icon name={c.icon} /></span>
            <span><span className="service-name">{t(c.title)}</span><span className="service-desc">{tx(c.desc)}</span></span>
          </button>
        ))}
      </div>
      <div style={{ marginTop: 14 }} aria-live="polite">
        {wizard.paymentChoice && (
          <div className={`notice${wizard.paymentChoice === 'recorded' ? '' : ' warn'}`}><strong>{feedback}</strong>{t('paymentNotice')}</div>
        )}
      </div>
      <div className="between" style={{ marginTop: 18 }}>
        <button type="button" className="btn btn-outline" onClick={() => updateWizard({ bookStep: 4 })}>{t('back')}</button>
        <button type="button" className="btn btn-primary" onClick={finish} disabled={!wizard.paymentChoice}>{t('finish')}</button>
      </div>
    </div>
  );
}

function ResultStep() {
  const { t, tx } = useLanguage();
  const { wizard, bookings, resetWizard } = useDemo();
  const navigate = useNavigate();
  const b = wizard.currentBooking ?? bookings[0];
  const rows: Array<[string, string]> = [['paymentStatus', b.payment], ['thresholdStatus', b.threshold], ['opsStatus', b.ops], ['boardingStatus', b.boarding]];
  return (
    <div className="card card-pad">
      <div className="between">
        <div><div className="eyebrow">{t('stepResult')} 5/5</div><h2 className="card-title" style={{ fontSize: 25 }}>{t('resultTitle')}</h2><p className="card-desc">{t('resultSub')}</p></div>
        <StatusPill text={tx('DEMO')} />
      </div>
      <div className="hero-panel" style={{ marginTop: 18, minHeight: 0 }}>
        <div className="eyebrow" style={{ color: '#a7e5e0' }}>{tx('BOOKING REFERENCE · FICTIONAL')}</div>
        <h2 style={{ fontSize: 27 }} className="mono">{b.ref}</h2>
        <p>{tx(b.service)} · {b.date} · {b.time}</p>
        <div className="hero-meta">
          <span>{b.passengers} {tx('passenger(s) demo')}</span>
          <span>SAR {Number(b.amount).toLocaleString('en-US')} {tx('before unconfirmed taxes')}</span>
          <span>{tx('Destination')}: {tx(b.dest)}</span>
        </div>
      </div>
      <div className="status-grid" style={{ marginTop: 17 }}>
        {rows.map(([label, val]) => (
          <div key={label} className="status-item"><div className="status-label">{t(label)}</div><div className="status-text">{tx(val)}</div><StatusPill text={val} /></div>
        ))}
      </div>
      {b.return && (
        <div className="inset" style={{ marginTop: 14 }}>
          <strong>{t('returnLeg')} · {b.return.date} · <span className="mono">{b.return.time}</span></strong>
          <div className="small muted">{tx(b.return.dest)} — {tx('separate sailing and ticket.')}</div>
        </div>
      )}
      {wizard.service === 'combined' && (
        <div className="notice warn" style={{ marginTop: 14 }}><strong>{t('materialPending')}</strong>{tx('Passenger fare only is shown. Materials still require review/quote and are not included in the total.')}</div>
      )}
      <div className="notice warn" style={{ marginTop: 17 }}><strong>{t('thresholdStatus')}</strong>{t('thresholdExplainer')}</div>
      <div className="between" style={{ marginTop: 19 }}>
        <button type="button" className="btn btn-outline" onClick={() => navigate('/bookings')}>{t('viewBookings')}</button>
        <button type="button" className="btn btn-primary" onClick={resetWizard}>{t('newBooking')}</button>
      </div>
    </div>
  );
}

export default function BookingView() {
  const { t, tx } = useLanguage();
  const { wizard } = useDemo();
  const step = wizard.bookStep;
  return (
    <>
      <PageHeader titleKey="bookTitle" subKey="bookSub" eyebrow="GULF MOVER / CUSTOMER" />
      <div className="hero-panel" style={{ marginBottom: 18 }}>
        <div className="eyebrow" style={{ color: '#8ee1dc' }}>{t('customer')}</div>
        <h2>{t('quick')}</h2>
        <p>{t('homeCopy')}</p>
        <div className="hero-meta">
          <span>{t('briefFare')}: <b>SAR 500</b> {t('perTrip')}</span>
          <span>{t('schedule')}: <b className="mono">07:00 · 09:30 · 13:00</b></span>
          <span>{t('localTime')}</span>
        </div>
      </div>
      <Stepper step={step} />
      {step === 1 ? <ServiceStep /> : step === 2 ? <JourneyStep /> : step === 3 ? <DetailsStep /> : step === 4 ? <ReviewStep /> : step === 5 ? <PaymentStep /> : <ResultStep />}
      <p className="footer-note">{tx('All sample records, availability and statuses are fictional. Initial fare and departure times are taken from the client brief; final tariffs, tax, capacities, routes, permits and policies require ATCO confirmation.')}</p>
    </>
  );
}

