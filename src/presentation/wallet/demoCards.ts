// Fictional example cards that make the simulated Wallets look lived-in. Visual props only:
// invented issuers and holder, masked numbers, no card data of any kind, and every card is
// marked DEMO. They cannot pay for anything; the Wallet screens say so on each card.

export type CardNetwork = 'visa' | 'mastercard' | 'charge';

export interface DemoCard {
  id: string;
  issuer: string;
  product: string;
  network: CardNetwork;
  /** Masked number as printed on the card face. */
  masked: string;
  last4: string;
  holder: string;
  expiry: string;
  art: 'gold' | 'navy' | 'graphite';
}

export const DEMO_CARDS: readonly DemoCard[] = [
  { id: 'demo-gold', issuer: 'Meridian Express', product: 'Gold Card', network: 'charge', masked: '•••• •••••• •1007', last4: '1007', holder: 'NOURA AL-HARBI', expiry: '08/29', art: 'gold' },
  { id: 'demo-visa', issuer: 'Gulf Coast Bank', product: 'Signature', network: 'visa', masked: '•••• •••• •••• 4821', last4: '4821', holder: 'NOURA AL-HARBI', expiry: '11/28', art: 'navy' },
  { id: 'demo-mc', issuer: 'Dhahran Digital', product: 'World', network: 'mastercard', masked: '•••• •••• •••• 5530', last4: '5530', holder: 'NOURA AL-HARBI', expiry: '03/30', art: 'graphite' },
];
