# Gulf Mover Marine Taxi Platform - Local Mock App

This is a locally runnable mock app for the Gulf Mover Marine Taxi Platform built with Vite + React + TypeScript.

## Prerequisites
- Node.js (v18+ recommended)
- npm (comes with Node.js)

## Project Structure
- `src/` - Source code for the React application
- `docs/` - Documentation including source map, requirements traceability, test results, and limitations
- `reference/` - Original source documents (do not modify)
- `CLAUDE.md` - Project instructions
- `CLAUDE_CODE_BUILD_PROMPT.md` - Build prompt used with Claude Code

## Available Scripts

In the project directory, you can run:

### Development
```bash
npm run dev
```
Starts the development server at http://localhost:5173

### Build
```bash
npm run build
```
Builds the app for production to the `dist/` folder

### Preview
```bash
npm run preview
```
Preview the production build locally

## Features Implemented

### Six Demonstratable Views
1. **Customer Booking Flow** (`/`) - Service selection, journey details, passenger information, fare review, payment simulation
2. **My Bookings / Ticket Detail** (`/bookings`) - Booking search, list view, detailed ticket view with status dimensions
3. **Corporate and Agent Workspace** (`/corporate`) - Organization overview, booking management, passenger lists, invoices, settlements
4. **ATCO Operations Dashboard** (`/operations`) - Sailing schedule, threshold monitoring, approval controls, materials/finance queues
5. **Boarding/Check-in View** (`/boarding`) - QR-style scan simulation, manual lookup, duplicate scan prevention, boarding counter
6. **Materials Request/Review View** (`/materials`) - Material request form, review queue, decision workflow

### Key Features
- **Language Toggle**: English/Arabic switching with correct RTL layout
- **Demo Mode**: All data is fictional and stored locally (in memory)
- **Reset Functionality**: Reset demo data to initial state
- **Status Separation**: Payment, threshold, operational readiness, and boarding status are independent
- **Minimum Threshold Rule**: Four eligible tickets across all bookings for same sailing (SAR 500 × 4 = SAR 2,000 equivalent)
- **Return Leg Handling**: Outbound and return are separate sailings
- **Payment Simulation**: No real payment processing - clearly labeled as demo

### Demo Limitations
- No real authentication, payment processing, or external API integration
- All data is mock/fictional
- No actual port/permit/vessel operations
- Role-based access is simulated, not enforced
- Use placeholders for unresolved ATCO decisions (exact routes, vessel details, VAT treatment, etc.)

## How to Use

1. **Start the app**: `npm run dev`
2. **Switch language**: Click the language toggle (EN/العربية) in the header
3. **Navigate views**: Use the navigation buttons in the header
4. **Reset data**: Click "Reset Demo Data" in any view footer
5. **Test features**: Try booking flows, boarding simulations, material reviews, etc.

## Build for Production
```bash
npm run build
```
This creates optimized static assets in the `dist/` directory.

## Testing
The app includes basic UI tests for:
- Language toggle and RTL switching
- Fare calculation (SAR 500 × passengers × legs)
- Minimum threshold logic (4 tickets across bookings)
- Navigation between views
- Status separation (payment ≠ boarding ≠ operational approval)

## Notes
- This is a mock/demonstration app only
- No real credentials, payments, or operational data are used
- All business rules are simulated based on source document analysis
- For actual deployment, backend integration and real authentication would be required