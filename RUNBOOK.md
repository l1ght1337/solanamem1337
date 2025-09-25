# Solana Trading Bot - Runbook

## Content Security Policy (CSP) Configuration

### Production Build CSP Compliance

The application is configured to run without requiring `'unsafe-eval'` in the Content Security Policy. This provides better security for production deployments.

#### CSP Configuration

The application includes a CSP header in `index.html`:
```html
<meta http-equiv="Content-Security-Policy" content="script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'self';" />
```

#### Cloudflare Configuration

When deploying with Cloudflare, ensure your CSP headers do NOT include `'unsafe-eval'`. The recommended CSP for production:

```
Content-Security-Policy: script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'self'; connect-src 'self' https:; img-src 'self' data: https:; style-src 'self' 'unsafe-inline';
```

#### Testing CSP Compliance

1. Build the production bundle:
   ```bash
   pnpm build
   ```

2. Preview the production build:
   ```bash
   pnpm preview
   ```

3. Open browser DevTools and check the Console tab - there should be no CSP eval errors.

#### Build Configuration

The Vite configuration has been optimized for CSP compliance:
- Sourcemaps disabled in production
- Dynamic imports properly handled without eval
- No unsafe eval usage in minified output

## Number Input Handling

### Locale Number Support

The application now supports both comma and dot decimal separators:

#### Input Processing

All number inputs accept:
- Dot notation: `0.02`, `1.5`, `100.25`
- Comma notation: `0,02`, `1,5`, `100,25`

#### Utils Available

```typescript
import { parseLocaleNumber, safeParseNumber, toFixedOrZero } from './utils/number';

// Parse with locale support
const value = parseLocaleNumber("0,02"); // Returns 0.02

// Parse with fallback
const value = safeParseNumber("invalid", 0); // Returns 0

// Format safely
const display = toFixedOrZero(NaN, 5); // Returns "0.00000"
```

#### NaN Prevention

All calculated fields (average, realized, unrealized) use safe math functions that prevent NaN propagation:

- `safeAdd(a, b)` - Addition with NaN protection
- `safeMultiply(a, b)` - Multiplication with NaN protection
- `safeDivide(a, b)` - Division with zero/NaN protection

### Form Field Configuration

All form elements now have proper `id` and `name` attributes for DevTools compliance:

#### Bot Configuration Inputs
- Strategy selector: `id="bot-{botId}-strategy"`, `name="strategy"`
- Budget input: `id="bot-{botId}-budget"`, `name="budget"`
- Speed input: `id="bot-{botId}-speed"`, `name="speed"`
- AI checkbox: `id="bot-{botId}-ai"`, `name="aiEnabled"`
- Manual lock: `id="bot-{botId}-manual"`, `name="manualLock"`

## Bot Stability and Scheduler

### Central Scheduler

A central scheduler prevents bot start/stop race conditions:

#### Features
- Atomic start/stop operations
- Abort signal propagation
- Staggered startup (0-400ms delay)
- Proper cleanup on errors

#### Usage

The scheduler automatically handles:
```typescript
// Safe start - checks if already running
await store.startBot(botId, connection);

// Safe stop - aborts and cleans up
store.stopBot(botId);
```

## Sell ALL Fast Path

### Parallel Execution

The Sell ALL feature executes transfers in parallel without artificial delays:

#### Configuration

Set in `.env`:
```
VITE_MAX_PARALLEL_SENDS=10
VITE_PRIORITY_FEE_MIN=1500
```

#### Process

1. **Transfer Phase**: All bots transfer tokens to destination in parallel
2. **Aggregation**: Single swap transaction from aggregated balance
3. **Progress Tracking**: Real-time progress updates with retry counts

#### Features
- No 1-second delays between operations
- Priority fee support from environment
- Compute budget optimization
- Retry logic with exponential backoff

## Environment Variables

Copy `.env.example` to `.env` and configure:

### Required Variables
```bash
VITE_MAX_PARALLEL_SENDS=10          # Parallel transfer limit
VITE_COMPUTE_UNITS=1000000          # Transaction compute units
VITE_PRIORITY_FEE_MIN=1500          # Minimum priority fee (lamports)
VITE_PRIORITY_FEE_MAX=25000         # Maximum priority fee (lamports)
```

### Optional Variables
```bash
VITE_API_BASE=                      # Custom API endpoint
VITE_PUMP_API=                      # Pump.fun API override
VITE_JUP_FORCE_PROXY=0              # Force Jupiter CORS proxy
```

## Development vs Production

### Development
- CSP relaxed for hot reload
- Console errors visible
- Source maps enabled

### Production
- Strict CSP without unsafe-eval
- Console logs removed
- Source maps disabled
- Optimized bundle size

## Troubleshooting

### CSP Violations
1. Check browser console for CSP errors
2. Verify no `'unsafe-eval'` required
3. Test with strict CSP headers

### Number Input Issues
1. Verify locale parsing works with commas
2. Check for NaN in calculated fields
3. Validate safe math usage

### Bot Stability Issues
1. Check scheduler state in DevTools
2. Verify abort signals are working
3. Monitor for race conditions

### Performance Issues
1. Monitor parallel send limits
2. Check priority fee configuration
3. Verify compute budget settings