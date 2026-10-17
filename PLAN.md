# Gulf Mover Marine Taxi Platform - Implementation Plan

## Verified Facts (from source inspection)
1. **Fare Structure**: SAR 500 per passenger per one-way leg (confirmed in prototype)
2. **Core Views**: Six demonstrable views required:
   - Customer booking flow
   - My Bookings / ticket detail
   - Corporate and agent/reseller workspace
   - ATCO operations dashboard
   - Boarding/check-in view
   - Materials request/review view
3. **Language Requirements**: English and Arabic required, with proper RTL layout
4. **Departure Examples**: 07:00, 09:30, 13:00 Saudi local time (demo/proposed)
5. **Minimum Threshold**: Four eligible passenger tickets across all bookings for same sailing
6. **Status Separation**: Booking, payment, minimum threshold, permit/port readiness, operational approval/sailing status, boarding state are distinct
7. **Return Leg**: Separate sailing, ticket and capacity reservation linked to outbound journey
8. **VAT Treatment**: Excluded unless approved tariff says otherwise (do not invent)
9. **Demo Boundaries**: No real payment, credentials, or production data simulation
10. **Prototype Exists**: Bilingual HTML prototype available at `reference/Gulf Mover Marine Taxi Platform/03 - UX UI and Brand/Wireframes and Clickable Prototype/gulf_mover_ui_prototype_bilingual.html`

## Open Questions (Requiring Agent Input)
1. Exact Arabic translation completeness and accuracy
2. Detailed workflow steps for each view (beyond prototype)
3. Specific business rules for agent/credit/settlement, materials/charter
4. Security/access control specifications
5. Detailed design system tokens and components
6. Validation criteria for success/error states
7. Specific data model entities and relationships
8. Error handling and validation rules

## Chosen Technology Stack
- **Framework**: Vite + React + TypeScript (standard choice unless inspection reveals reason otherwise)
- **State Management**: React Context API or Zustand (to be confirmed based on complexity)
- **Styling**: CSS Modules or Tailwind CSS (to maintain design system fidelity)
- **Internationalization**: react-i18next or similar for EN/Arabic toggle with RTL
- **Mock Data**: In-memory state with localStorage persistence option
- **Build Tool**: Vite (for fast dev server and building)
- **TypeScript**: Strict mode for type safety

## Module Plan
1. **App Shell**
   - Layout components (header, footer, sidebar)
   - Language context/provider (EN/AR toggle with RTL)
   - Demo mode context (fake data, simulation flags)
   - Router configuration for six main views

2. **Shared Components**
   - UI Kit (buttons, inputs, cards, modals, tables)
   - Language toggle component
   - Demo banners and disclaimers
   - Status indicators (payment, threshold, operations, boarding)
   - Loading/error/empty states

3. **View Modules**
   - **Customer Booking Flow**
     - Service selection (passenger/material/combined/charter)
     - Journey/search interface
     - Date/time selection (07:00, 09:30, 13:00 options)
     - Passenger quantity selection
     - Fare calculation display (SAR 500 × passengers × legs)
     - Policy acknowledgements
     - Payment simulation (no real gateway)
     - Booking confirmation with status dimensions

   - **My Bookings / Ticket Detail**
     - Booking reference search
     - List view with status columns
     - Detailed ticket view showing all status dimensions
     - Action buttons (amend, refund, etc. - simulated)

   - **Corporate/Agent Workspace**
     - Role switcher (demo-only)
     - Organization overview
     - Booking management
     - Passenger lists
     - Invoice/view
     - Settlement tracking (agent)

   - **ATCO Operations Dashboard**
     - sailing schedule/status board
     - Minimum threshold monitoring (4 tickets across bookings)
     - Operational approval controls
     - Materials review queue
     - Finance exceptions queue
     - Audit trail/attention queues

   - **Boarding/Check-in View**
     - QR-style scan simulation
     - Manual booking reference lookup
     - Duplicate scan prevention
     - Boarding counter (boarded/eligible)
     - Manual override with reason requirement

   - **Materials Request/Review View**
     - New material request form
     - Review queue with status (pending/clarification/rejected/approved)
     - Request details (description, quantity, weight, dimensions)
     - Decision workflow (approve with conditions, request clarification, reject)

4. **Services/Hooks**
   - Mock data service (fictional bookings, organizations, sailings)
   - Language service (translation files)
   - Demo state management (localStorage option)
   - Utility helpers (currency formatting, date handling RTL-aware)

5. **Tests**
   - Unit tests for fare calculation and threshold logic
   - Integration tests for navigation and language toggle
   - Mock service tests
   - RTL rendering tests (where practical)

## Subagent Assignments (Completed)
- **gulf-mover-requirements-analyst**: Analyzing local source documents for confirmed requirements, evidence paths, contradictions and ATCO questions
- **gulf-mover-ux-rtl-reviewer**: Reviewing local bilingual prototype, wireframes, design system and Arabic/RTL coverage
- **gulf-mover-workflow-reviewer**: Reviewing booking/payment/minimum-threshold/operations/boarding/material/agent states and role boundaries
- **gulf-mover-drive-source-auditor**: Auditing local Gulf Mover source snapshot for inventory and source mapping

## Definition of Done
- Working local app with exact start/build/test commands in README.md
- Responsive desktop/tablet/mobile interface
- Language toggle translating all visible copy with correct LTR/RTL
- Six demonstrable views implemented with simulated workflows
- Demo-only role/workspace switcher (not real authentication)
- Tests for core state rules, localization/RTL, navigation, return-leg separation, shared four-ticket threshold
- Updated documentation:
  - `docs/source-map.md` (with agent findings)
  - `docs/requirements-traceability.md`
  - `docs/test-results.md`
  - `docs/demo-limitations.md`
- No deployment/publishing, no real credentials or payment processing
- Clear demo labeling and reset-demo-data functionality

## Next Steps
1. Await findings from specialist subagents
2. Update PLAN.md and source-map.md with agent findings
3. Begin implementation of Vite + React + TypeScript project structure
4. Create core app shell and navigation
5. Implement language/context system with RTL support
6. Build out each of the six views incrementally
7. Add simulated data and state management
8. Implement tests where practical
9. Run independent QA review
10. Finalize documentation