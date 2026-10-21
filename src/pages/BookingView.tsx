import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useDemo, type ServiceType, type PaymentChoice } from '../context/DemoContext';
import { useUi } from '../context/UiContext';
import { PageHeader } from '../components/PageHeader';
import { StatusPill } from '../components/StatusPill';
import { ArrowIcon, Icon, type IconName } from '../components/Icon';
import { BOATS, CITIES, DESTINATIONS, ORIGIN, today, nowTime } from '../data/demoData';
import { ContactAtcoLink } from '../components/ContactCard';
import { FARE_PER_PASSENGER_LEG, fareTotal, legCount } from '../domain/rules';
import { BRIEF_TIMES, TIME_SLOTS, boatAvailability, canBookPassengers, canCharter, findSlot, formatTime, type Availability } from '../domain/fleet';
import { DEMO_POLICY_VERSION, type Ticket } from '../domain/tickets';
import { QRCodeTicket } from '../components/QRCodeTicket';
import { DeviceWalletButton } from '../components/wallet/WalletHostBridge';
import { useTicketIndex, type TicketEntry } from '../hooks/useTicketIndex';

const SERVICES: ReadonlyArray<{ value: ServiceType; title: string; desc: string; icon: IconName }> = [
  { value: 'passenger', title: 'servicePassenger', desc: 'servicePassengerDesc', icon: 'user' },
  { value: 'material', title: 'serviceMaterial', desc: 'serviceMaterialDesc', icon: 'box' },
  { value: 'combined', title: 'serviceCombined', desc: 'serviceCombinedDesc', icon: 'list' },
  { value: 'charter', title: 'serviceCharter', desc: 'serviceCharterDesc', icon: 'ship' },
];

function Stepper({ step: wizardStep }: { step: number }) {
  const { t } = useLanguage();
  const names = [t('stepService'), t('stepSearch'), t('stepDetails'), t('stepReview'), t('stepResult')];
  // Six wizard screens, five labels: the payment simulation (5) belongs to "Review & pay" (4).
  const step = wizardStep >= 5 ? wizardStep - 1 : wizardStep;
  return (
    <ol className="stepper" data-tour="booking-steps">
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
  const { wizard, updateWizard } = useDemo();

  return (
    <div className="card card-pad">
      <div className="between">
        <div><h2 className="card-title">{t('serviceTitle')}</h2><p className="card-desc">{t('homeCopy')}</p></div>
        <span className="pill pill-blue">{t('stepService')} 1/5</span>
      </div>
      <div className="grid grid-2" style={{ marginTop: 18 }} data-tour="booking-services">
        {SERVICES.map(s => (
          <button key={s.value} type="button" aria-pressed={wizard.service === s.value}
            className={`service-card${wizard.service === s.value ? ' selected' : ''}`}
            onClick={() => updateWizard({ service: s.value, bookStep: 1, formError: '', ...(s.value === 'charter' ? { addReturn: false } : {}) })}>
            <span className="service-icon"><Icon name={s.icon} /></span>
            <span><span className="service-name">{t(s.title)}</span><span className="service-desc">{t(s.desc)}</span></span>
          </button>
        ))}
      </div>
      {wizard.service === 'charter' && (
        <div className="notice warn" style={{ marginTop: 15 }}><strong>{t('serviceCharter')}</strong>{t('charterWholeBoat')}</div>
      )}
      <div className="between" style={{ marginTop: 20 }}>
        <span className="small muted">{t('briefFare')}: <strong>SAR 500</strong> {t('perTrip')}</span>
        <button type="button" className="btn btn-primary" onClick={() => updateWizard({ bookStep: 2 })}>{t('continue')} <ArrowIcon /></button>
      </div>
    </div>
  );
}

const SLOT_GROUPS: ReadonlyArray<{ key: string; from: number; to: number }> = [
  { key: 'slotNight', from: 0, to: 5 }, { key: 'slotMorning', from: 6, to: 11 },
  { key: 'slotAfternoon', from: 12, to: 17 }, { key: 'slotEvening', from: 18, to: 23 },
];

/** Whether a boat can be picked for this service at the given slot. */
function boatAllowed(service: ServiceType, av: Availability): boolean {
  return service === 'charter' ? canCharter(av) : canBookPassengers(av);
}

function TimeSelect({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  const { t, lang } = useLanguage();
  return (
    <div className="field">
      <label htmlFor={id}>{label} *</label>
      <select id={id} value={value} onChange={e => onChange(e.target.value)}>
        {SLOT_GROUPS.map(g => (
          <optgroup key={g.key} label={t(g.key)}>
            {TIME_SLOTS.filter(s => { const h = Number(s.slice(0, 2)); return h >= g.from && h <= g.to; }).map(s => (
              <option key={s} value={s}>{formatTime(s, lang)}{BRIEF_TIMES.includes(s) ? ` · ${t('briefTimeTag')}` : ''}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <small>{t('localTime')}</small>
    </div>
  );
}

function BoatChoices({ leg }: { leg: 'outbound' | 'return' }) {
  const { t, lang } = useLanguage();
  const { wizard, updateWizard, boatSlots } = useDemo();
  const date = leg === 'return' ? wizard.returnDate : wizard.journeyDate;
  const time = leg === 'return' ? wizard.selectedRet : wizard.selectedOut;
  const current = leg === 'return' ? wizard.selectedRetBoat : wizard.selectedBoat;
  return (
    <div style={{ marginTop: 15 }}>
      <div className="between" style={{ marginBottom: 9 }}>
        <strong className="card-title">{leg === 'return' ? t('returnBoat') : t('chooseBoat')}</strong>
        <span className="tiny muted">{date} · {formatTime(time, lang)}</span>
      </div>
      <div className="grid grid-3">
        {BOATS.map(boat => {
          const av = boatAvailability(boatSlots, boat.id, date, time);
          const slot = findSlot(boatSlots, boat.id, date, time);
          const allowed = boatAllowed(wizard.service, av);
          const selected = current === boat.id && allowed;
          const label = av === 'free' ? t('avFree')
            : av === 'chartered' ? t('avChartered')
              : wizard.service === 'charter' ? t('avHasPassengers') : t('avShared').replace('{n}', String(slot?.passengers ?? 0));
          return (
            <button key={boat.id} type="button" disabled={!allowed} aria-pressed={selected}
              className={`boat-option${selected ? ' selected' : ''}${allowed ? '' : ' taken'}`}
              onClick={() => updateWizard(leg === 'return' ? { selectedRetBoat: boat.id } : { selectedBoat: boat.id })}>
              <span className={`radio${selected ? ' on' : ''}`} />
              <span className="boat-body">
                <span className="boat-name">{boat.name[lang]}</span>
                <span className={`pill ${!allowed ? 'pill-red' : av === 'shared' ? 'pill-gold' : 'pill-green'}`}>{label}</span>
              </span>
              <span className="fare-cell">{wizard.service === 'charter'
                ? <span className="fare-note">{t('charterNoPrice')}</span>
                : <><span className="fare">SAR {FARE_PER_PASSENGER_LEG}</span><br /><span className="fare-note">{t('perPassenger')}</span></>}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function JourneyStep() {
  const { t, tx, lang } = useLanguage();
  const { wizard, updateWizard, boatSlots } = useDemo();
  const { toast } = useUi();
  const isCharter = wizard.service === 'charter';
  const legOk = (boatId: string, date: string, time: string) => boatAllowed(wizard.service, boatAvailability(boatSlots, boatId, date, time));

  const next = () => {
    if (!wizard.journeyDate) { toast(t('chooseDate')); return; }
    if (!legOk(wizard.selectedBoat, wizard.journeyDate, wizard.selectedOut)) { toast(t('boatTaken')); return; }
    if (wizard.addReturn) {
      if (!wizard.returnDate) { toast(t('chooseReturnDate')); return; }
      if (wizard.returnDate < wizard.journeyDate) { toast(t('returnAfter')); return; }
      if (!legOk(wizard.selectedRetBoat, wizard.returnDate, wizard.selectedRet)) { toast(t('boatTaken')); return; }
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
          <label htmlFor="city-select">{t('city')} *</label>
          <select id="city-select" value={wizard.city} onChange={e => updateWizard({ city: e.target.value })}>
            {CITIES.map(c => <option key={c.id} value={c.id}>{c.name[lang]}</option>)}
          </select>
          <small>{t('cityHint')}</small>
        </div>
        <div className="field">
          <label htmlFor="journey-date">{t('departureDate')} *</label>
          <input id="journey-date" type="date" value={wizard.journeyDate} min={today()} onChange={e => updateWizard({ journeyDate: e.target.value })} />
        </div>
        <TimeSelect id="departure-time" label={t('departureTime')} value={wizard.selectedOut} onChange={v => updateWizard({ selectedOut: v })} />
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
      <BoatChoices leg="outbound" />
      <div className="divider" />
      {isCharter ? <p className="card-desc">{t('charterWholeBoat')}</p> : (
        <>
          <label className="switch">
            <input type="checkbox" id="return-toggle" checked={wizard.addReturn} onChange={e => updateWizard({ addReturn: e.target.checked })} />
            <span>{t('returnToggle')}</span>
          </label>
          {wizard.addReturn ? (
            <>
              <h3 className="card-title" style={{ marginTop: 14 }}>{t('returnSailing')}</h3>
              <div className="form-grid" style={{ marginTop: 10 }}>
                <div className="field">
                  <label htmlFor="return-date">{t('returnDate')} *</label>
                  <input type="date" id="return-date" value={wizard.returnDate} min={today()} onChange={e => updateWizard({ returnDate: e.target.value })} />
                </div>
                <TimeSelect id="return-time" label={t('returnTime')} value={wizard.selectedRet} onChange={v => updateWizard({ selectedRet: v })} />
                <div className="field"><label>{t('destination')}</label><div className="inset">{tx(wizard.chosenDestination)}</div></div>
              </div>
              <BoatChoices leg="return" />
            </>
          ) : <p className="card-desc" style={{ marginTop: 10 }}>{t('returnHint')}</p>}
        </>
      )}
      {(wizard.service === 'material' || wizard.service === 'combined') && (
        <div className="notice warn" style={{ marginTop: 16 }}><strong>{t('materialPending')}</strong>{t('serviceMaterialDesc')} {t('capacityNotSet')}</div>
      )}
      <div className="between" style={{ marginTop: 20 }}>
        <button type="button" className="btn btn-outline" onClick={() => updateWizard({ bookStep: 1 })}>{t('back')}</button>
        <button type="button" className="btn btn-primary" onClick={next}>{t('continue')} <ArrowIcon /></button>
      </div>
      <p className="footer-note">{isCharter ? t('charterNoPrice') : `${t('fareFormula')}. ${t('vatPending')}.`}</p>
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

  const field = (id: string, labelKey: string, key: 'passengerName' | 'passengerEmail' | 'passengerPhone' | 'passengerCompany' | 'vessel' | 'imo' | 'po',
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
        {field('po-field', 'poLabel', 'po', { placeholder: 'PO-DEMO-0042', hint: t('poHint') })}
      </div>
      {wizard.paxCount > 1 && (
        <div className="form-grid" style={{ marginTop: 15 }} aria-label={t('detailsPassengersHint')}>
          {Array.from({ length: Math.min(7, wizard.paxCount - 1) }, (_, i) => i + 2).map(n => (
            <div className="field" key={`pex-${n}`}>
              <label htmlFor={`pax-name-${n}`}>{t('passengerNameN').replace('{n}', String(n))}</label>
              <input id={`pax-name-${n}`} value={wizard.extraPassengerNames[n - 2] ?? ''}
                onChange={e => {
                  const next = [...wizard.extraPassengerNames];
                  next[n - 2] = e.target.value;
                  updateWizard({ extraPassengerNames: next });
                }} />
            </div>
          ))}
          <small>{t('detailsPassengersHint')}</small>
        </div>
      )}
      <div className="notice" style={{ marginTop: 17 }}><strong>{t('noSensitive')}</strong>{t('detailsSub')}</div>
      <div className="between" style={{ marginTop: 20 }}>
        <button type="button" className="btn btn-outline" onClick={() => updateWizard({ bookStep: 2 })}>{t('back')}</button>
        <button type="button" className="btn btn-primary" onClick={next}>{t('continue')} <ArrowIcon /></button>
      </div>
    </div>
  );
}

function ReviewStep() {
  const { t, tx, lang } = useLanguage();
  const { wizard, updateWizard, resetWizard, materials, addMaterial, bookings, requestCharter } = useDemo();
  const { toast } = useUi();
  const navigate = useNavigate();
  const pax = Math.max(1, wizard.paxCount);
  const materialOnly = wizard.service === 'material';
  const isCharter = wizard.service === 'charter';
  const noPayment = materialOnly || isCharter;
  const total = noPayment ? 0 : fareTotal(pax, wizard.addReturn);
  const boatName = (id: string) => BOATS.find(b => b.id === id)?.name[lang] ?? id;
  const cityName = CITIES.find(c => c.id === wizard.city)?.name[lang] ?? wizard.city;
  const legLine = (labelKey: string, date: string, time: string, boatId: string) => (
    <>
      <div className="between"><strong>{t(labelKey)}</strong><StatusPill text="DEMO DATA" /></div>
      <p className="small muted">{cityName} · {date} · <b className="mono">{formatTime(time, lang)}</b> · {tx(wizard.chosenDestination)} · {boatName(boatId)}</p>
      {!isCharter && <div className="between"><span>{pax} × {t('perPassenger')}</span><strong>SAR {pax * FARE_PER_PASSENGER_LEG}</strong></div>}
    </>
  );

  const next = () => {
    if (!wizard.policyAck || !wizard.accessAck) { toast(t('ackFirst')); return; }
    if (isCharter) {
      const ref = `CH-DEMO-${String(100 + bookings.length + 1).padStart(4, '0')}`;
      const holder = wizard.passengerCompany || wizard.passengerName || 'Demo requestor';
      if (!requestCharter(wizard.selectedBoat, wizard.journeyDate, wizard.selectedOut, pax, ref, holder)) {
        toast(t('boatTaken'));
        updateWizard({ bookStep: 2 });
        return;
      }
      toast(t('charterReserved'));
      resetWizard();
      navigate('/fleet');
      return;
    }
    if (materialOnly) {
      // Material-only requests skip the passenger reservation entirely.
      const id = `MR-DEMO-${String(materials.length + 1).padStart(2, '0')}`;
      addMaterial({ id, name: 'New material request (demo)', qty: 'To be reviewed', weight: 'Not provided', size: 'Not provided', status: 'Pending review',
        sender: wizard.passengerCompany || 'Demo requestor', receiver: wizard.chosenDestination,
        detail: 'Submitted through the offline UI prototype only. No actual transport acceptance or charge.',
        vessel: wizard.vessel || wizard.chosenDestination });
      navigate('/materials');
      toast(t('materialPending'));
      return;
    }
    // Passenger (and combined) requests reach the payment simulation first.
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
        {legLine('outboundLeg', wizard.journeyDate, wizard.selectedOut, wizard.selectedBoat)}
        {wizard.addReturn && <><div className="divider" />{legLine('returnLeg', wizard.returnDate, wizard.selectedRet, wizard.selectedRetBoat)}</>}
        <div className="divider" />
        <div className="price-line"><span>{t('subtotal')}</span><strong>SAR {total.toLocaleString('en-US')}</strong></div>
        <div className="price-line"><span>{t('vat')}</span><strong>{t('vatPending')}</strong></div>
        <div className="price-line price-total"><span>{t('total')}</span>
          <strong>{isCharter ? t('charterNoPrice') : materialOnly ? t('materialNoPayment') : `SAR ${total.toLocaleString('en-US')} + ${tx('VAT/approved charges TBD')}`}</strong></div>
        <p className="footer-note">{isCharter ? t('charterWholeBoat') : materialOnly ? t('materialNoTariff') : t('fareFormula')}</p>
        <div className="divider" />
        <h3 className="card-title" style={{ marginBottom: 9 }}>{t('policyTitle')}</h3>
        <div className="notice warn"><strong>{t('policyDemo')}</strong>{t('ackAccess')}</div>
        <div className="grid" style={{ gap: 10, marginTop: 13 }}>
          <label className="checkrow"><input id="policy-ack" type="checkbox" checked={wizard.policyAck} onChange={e => updateWizard({ policyAck: e.target.checked })} /><span>{t('ackPolicy')}</span></label>
          <label className="checkrow"><input id="access-ack" type="checkbox" checked={wizard.accessAck} onChange={e => updateWizard({ accessAck: e.target.checked })} /><span>{t('ackAccess')}</span></label>
        </div>
        <div className="between" style={{ marginTop: 20 }}>
          <button type="button" className="btn btn-outline" onClick={() => updateWizard({ bookStep: 3 })}>{t('back')}</button>
          <button type="button" className="btn btn-primary" onClick={next}>{isCharter ? t('charterSubmit') : materialOnly ? t('materialSubmit') : t('simulatePayment')} <ArrowIcon /></button>
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
  const { t, tx, lang } = useLanguage();
  const { wizard, updateWizard, addMaterial, materials, createBooking } = useDemo();
  const { toast } = useUi();
  const choices: ReadonlyArray<{ value: PaymentChoice; title: string; desc: string; icon: IconName }> = [
    { value: 'recorded', title: 'payRecorded', desc: 'Local demo state only.', icon: 'check' },
    { value: 'pending', title: 'payPending', desc: 'Shows an uncertain/pending payment.', icon: 'clock' },
    { value: 'failed', title: 'payFailed', desc: 'No payment is made.', icon: 'alert' },
  ];
  const feedback = wizard.paymentChoice === 'recorded' ? t('recorded') : wizard.paymentChoice === 'pending' ? t('pending') : tx('Payment failed / uncertain (demo)');

  /* Booking creation is atomic: legs reserve together or not at all, tickets
     and policy acceptance are recorded on the shared demo booking. */
  const finish = () => {
    if (!wizard.paymentChoice) { toast(t('paymentNotice')); return; }
    const pax = Math.max(1, wizard.paxCount);
    // Per-passenger names (lead uses the main field; extras are optional demo data).
    const passengerNames = [wizard.passengerName.trim() || 'Demo Passenger'];
    for (let i = 2; i <= pax; i++) passengerNames.push(wizard.extraPassengerNames[i - 2]?.trim() || `Passenger ${i}`);
    const legs: Array<{ boatId: string; date: string; time: string }> = [
      { boatId: wizard.selectedBoat, date: wizard.journeyDate, time: wizard.selectedOut },
    ];
    if (wizard.addReturn && wizard.returnDate) legs.push({ boatId: wizard.selectedRetBoat, date: wizard.returnDate, time: wizard.selectedRet });
    const policyAccepted = wizard.policyAck && wizard.accessAck
      ? { version: DEMO_POLICY_VERSION, acceptedAt: `${today()} ${nowTime()}` }
      : null;
    const result = createBooking({
      legs,
      dest: wizard.chosenDestination,
      passengers: pax,
      passengerNames,
      payment: wizard.paymentChoice,
      addReturn: wizard.addReturn && !!wizard.returnDate,
      policyAccepted,
      po: wizard.po || undefined,
      bookingContact: `${wizard.passengerName.trim()} · ${wizard.passengerEmail.trim()}`.replace(/^ · | · $/, '') || undefined,
    });
    if (!result.ok) {
      toast(result.reason === 'chartered' ? t('boatTaken') : t('noCapacity'));
      updateWizard({ bookStep: 2 });
      return;
    }
    const booking = result.booking;
    if (wizard.service !== 'passenger') {
      addMaterial({ id: `MR-DEMO-${String(materials.length + 1).padStart(2, '0')}`, name: 'New fictional material request', qty: 'To confirm',
        weight: 'Not provided', size: 'Not provided', status: 'Pending review', sender: 'Demo requestor', receiver: wizard.chosenDestination,
        detail: 'Created locally from the UI prototype; not submitted to an actual operator.',
        bookingRef: booking.ref, vessel: wizard.vessel || wizard.chosenDestination });
    }
    updateWizard({ bookStep: 6, currentBooking: booking });
  };

  const pax = Math.max(1, wizard.paxCount);
  const total = fareTotal(pax, wizard.addReturn);
  const legs: Array<[string, string, string]> = [['outboundLeg', wizard.journeyDate, wizard.selectedOut]];
  if (wizard.addReturn && wizard.returnDate) legs.push(['returnLeg', wizard.returnDate, wizard.selectedRet]);

  return (
    <div className="card card-pad pay-card">
      <div className="eyebrow">{t('stepReview')} · {tx('DEMO')}</div>
      <h2 className="card-title pay-title">{t('paymentTitle')}</h2>
      <p className="card-desc">{t('paymentSub')}</p>

      {/* What is being paid for: the same fare rule as the review step. */}
      <section className="pay-summary" aria-label={t('payTripTitle')}>
        <h3 className="pay-section-title">{t('payTripTitle')}</h3>
        <p className="pay-route">{tx(ORIGIN)} <span aria-hidden="true" className="dir-flip">→</span> {tx(wizard.chosenDestination)}</p>
        <ul className="pay-legs">
          {legs.map(([key, date, time]) => (
            <li key={key}><span>{t(key)}</span><span>{date} · <b className="mono">{formatTime(time, lang)}</b></span></li>
          ))}
          <li><span>{t('passengers')}</span><span>{pax}</span></li>
        </ul>
        <div className="price-line"><span>{t('subtotal')}</span><strong>SAR {total.toLocaleString('en-US')}</strong></div>
        <div className="price-line"><span>{t('vat')}</span><strong>{t('vatPending')}</strong></div>
        <div className="price-line price-total"><span>{t('total')}</span><strong>SAR {total.toLocaleString('en-US')}</strong></div>
      </section>

      <h3 className="pay-section-title" id="pay-choice-title">{t('payChoiceTitle')}</h3>
      <div className="pay-options" role="group" aria-labelledby="pay-choice-title">
        {choices.map(c => (
          <button key={c.value} type="button" aria-pressed={wizard.paymentChoice === c.value}
            className={`service-card pay-option${wizard.paymentChoice === c.value ? ' selected' : ''}`} onClick={() => updateWizard({ paymentChoice: c.value })}>
            <span className="service-icon"><Icon name={c.icon} /></span>
            <span><span className="service-name">{t(c.title)}</span><span className="service-desc">{tx(c.desc)}</span></span>
          </button>
        ))}
      </div>
      <div aria-live="polite">
        {wizard.paymentChoice && (
          <div className={`notice pay-feedback${wizard.paymentChoice === 'recorded' ? '' : ' warn'}`}><strong>{feedback}</strong></div>
        )}
      </div>
      <div className="notice warn pay-note"><strong>{t('demoOnly')}</strong>{t('paymentNotice')}</div>
      <div className="pay-actions">
        <button type="button" className="btn btn-outline" onClick={() => updateWizard({ bookStep: 4 })}>{t('back')}</button>
        <button type="button" className="btn btn-primary" onClick={finish} disabled={!wizard.paymentChoice}>{t('finish')}</button>
      </div>
    </div>
  );
}

/** `entry` adds the device Wallet button when the app is shown in the mock iPhone / Android. */
function TicketQrCard({ ticket, t, entry, saved = false }: { ticket: Ticket; t: (k: string) => string; entry?: TicketEntry; saved?: boolean }) {
  return (
    <div className="ticket-qr-card">
      <QRCodeTicket ticketId={ticket.id} size={120} />
      <div className="ticket-qr-body">
        <strong>{ticket.leg === 'return' ? t('returnLeg') : t('outboundLeg')}</strong>
        <div className="tiny muted">{ticket.passengerName}</div>
        <span className="pill pill-neutral tiny">{ticket.status === 'boarded' ? t('ticketBoarded') : t('ticketNotBoarded')}</span>
      </div>
      <span className="tiny muted" dir="ltr">{t('ticketScanHint')}</span>
      {entry && <DeviceWalletButton entry={entry} saved={saved} />}
    </div>
  );
}

function ResultStep() {
  const { t, tx, lang } = useLanguage();
  const { wizard, bookings, passes, resetWizard } = useDemo();
  const navigate = useNavigate();
  const b = wizard.currentBooking ?? bookings[0];
  const { entries } = useTicketIndex(bookings);
  const savedTicketIds = new Set(passes.map(p => p.ticketId));
  if (!b) return <div className="card card-pad"><p className="muted">{t('noBookings')}</p></div>;
  const rows: Array<[string, string]> = [['paymentStatus', b.payment], ['thresholdStatus', b.threshold], ['opsStatus', b.ops], ['boardingStatus', b.boarding]];
  return (
    <div className="card card-pad">
      <div className="between">
        <div><div className="eyebrow">{t('stepResult')} 5/5</div><h2 className="card-title" style={{ fontSize: 25 }}>{t('resultTitle')}</h2><p className="card-desc">{t('resultSub')}</p></div>
        <StatusPill text={tx('DEMO')} />
      </div>
      <div className="hero-panel" style={{ marginTop: 18, minHeight: 0 }}>
        <div className="eyebrow" style={{ color: '#78A98B' }}>{tx('BOOKING REFERENCE · FICTIONAL')}</div>
        <h2 style={{ fontSize: 27 }} className="mono">{b.ref}</h2>
        <p>{tx(b.service)} · {b.date} · {formatTime(b.time, lang)}</p>
        <div className="hero-meta">
          <span>{b.passengers} {tx('passenger(s) demo')}</span>
          <span>SAR {Number(b.amount).toLocaleString('en-US')} {tx('before unconfirmed taxes')}</span>
          <span>{tx('Destination')}: {tx(b.dest)}</span>
          {b.boatId && <span>{t('boat')}: {BOATS.find(x => x.id === b.boatId)?.name[lang]}</span>}
        </div>
      </div>
      <div className="status-grid" style={{ marginTop: 17 }}>
        {rows.map(([label, val]) => (
          <div key={label} className="status-item"><div className="status-label">{t(label)}</div><div className="status-text">{tx(val)}</div><StatusPill text={val} /></div>
        ))}
      </div>
      {b.tickets && b.tickets.length > 0 && (
        <div className="inset" style={{ marginTop: 14 }}>
          <strong>{t('ticketsQrTitle')}</strong>
          <div className="ticket-qr-grid">
            {b.tickets.map(tk => <TicketQrCard key={tk.id} ticket={tk} t={t}
              entry={entries.find(e => e.ticket.id === tk.id)} saved={savedTicketIds.has(tk.id)} />)}
          </div>
          <p className="small muted">{t('ticketsQrNote')}</p>
        </div>
      )}
      {b.return && (
        <div className="inset" style={{ marginTop: 14 }}>
          <strong>{t('returnLeg')} · {b.return.date} · <span className="mono">{formatTime(b.return.time, lang)}</span>{b.return.boatId && <> · {BOATS.find(x => x.id === b.return?.boatId)?.name[lang]}</>}</strong>
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
  const { t, tx, lang } = useLanguage();
  const { wizard } = useDemo();
  const step = wizard.bookStep;
  return (
    <div className="booking-flow" data-step={step}>
      <PageHeader titleKey="bookTitle" subKey="bookSub" eyebrow="ATCO MARINE / CUSTOMER" />
      <div className="hero-panel" style={{ marginBottom: 18 }}>
        <div className="eyebrow hero-eyebrow">{t('heroEyebrow')}</div>
        <h2>{t('quick')}</h2>
        <p>{t('homeCopy')}</p>
        <div className="hero-meta">
          <span>{t('city')}: <b>{CITIES.map(c => c.name[lang]).join(' · ')}</b></span>
          <span>{t('briefFare')}: <b>SAR 500</b> {t('perTrip')}</span>
          <span>{t('schedule')}: <b className="mono">{BRIEF_TIMES.map(x => formatTime(x, lang)).join(' · ')}</b></span>
          <span>{t('localTime')}</span>
          <span>{t('allDaySlots')}</span>
        </div>
      </div>
      <Stepper step={step} />
      {step === 1 ? <ServiceStep /> : step === 2 ? <JourneyStep /> : step === 3 ? <DetailsStep /> : step === 4 ? <ReviewStep /> : step === 5 ? <PaymentStep /> : <ResultStep />}
      <ContactAtcoLink />
      <p className="footer-note">{tx('All sample records, availability and statuses are fictional. Initial fare and departure times are taken from the client brief; final tariffs, tax, capacities, routes, permits and policies require ATCO confirmation.')}</p>
    </div>
  );
}

