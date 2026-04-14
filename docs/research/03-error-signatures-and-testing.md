# Research 03: Error Signatures, Redaction, and Snapshot Testing
Agent: scout-charlie
Started: 2026-04-13T00:00:00Z

## Progress Tracker
- [x] Sentry fingerprinting algorithm
- [x] Honeycomb error grouping
- [ ] Stable signature generation principles
- [ ] Presidio / OWASP PII detection
- [ ] Structured logging patterns
- [ ] GDPR pseudonymization
- [ ] VCR cassette pattern
- [ ] Jest snapshot testing
- [ ] Contract testing (Pact)
- [ ] Schema validation (Zod, JSON Schema)
- [ ] Property-based + differential testing
- [ ] Synthesis for Chorus

## Research Log

## [Sentry] - https://docs.sentry.io/concepts/data-management/event-grouping/ and https://develop.sentry.dev/backend/application-domains/grouping/

### Core Fingerprinting Algorithm

Sentry fingerprints error events based on information like `stacktrace`, `exception`, and `message`. Events with the same fingerprint are grouped into the same issue. The algorithm uses a hierarchical fallback system:

**Priority hierarchy:**
1. **Stack Trace** (preferred): By default, fingerprinting uses all lines in the entire stack trace.
2. **Exception Information** (fallback): If stack trace unavailable, uses type + value of exception when both present.
3. **Message** (last resort): Tries message without parameters first, then full message attribute.

### Three-Stage Pipeline

When no client-set fingerprint exists:
1. **Stack trace normalization** applies rules to adjust "in app" frame flags
2. **Server-side fingerprinting rules** can override defaults or incorporate them via `{{ default }}` placeholder
3. **Grouping algorithm** executes if fingerprint remains unset

**Two hash types produced**:
- **Flat hashes**: for standard grouping
- **Hierarchical hashes**: for subdividing groups within the UI

### Platform-Specific Fingerprinting (CRITICAL)

Different languages require DIFFERENT approaches due to source availability and minification:

| Platform | Signature Components | Rationale |
|----------|---------------------|-----------|
| **Python** | module name + function name + context-line (source code) | Requires source availability |
| **JavaScript** | module + filename (lowercased) + context-line | Source map limitations, minification instability |
| **Native (C/C++/Rust)** | demangled function names | Source typically unavailable; compiler variations create inconsistencies |

### Stack Trace Normalization (Key for Stability)

- **In-app frames prioritization**: "Only groups by stack trace frames that the SDK reports and associates with your application." Library/framework code is excluded from primary signature.
- **Normalized filenames**: Revision hashes removed (e.g. `app.a7f3b2.js` → `app.js`)
- **Normalized context lines**: Cleaned-up source code (whitespace, trivial differences removed)
- **Frame filtering**: Frames either removed from grouping entirely OR marked as 'out of app'
- **Out-of-app frames still generate secondary hashes**, enabling implied merges when configurations change—preventing unnecessary group fragmentation

### Message Fallback Normalization
When using message-based grouping:
- Takes the FIRST LINE of the message (not full multi-line)
- Applies cleanup logic: **replaces numbers and timestamps with placeholders**
- Known to over-fragment — this is why stacktrace is preferred

### Minified Code Warning
"Minimized JavaScript source code will destroy the grouping in detrimental ways." Sentry requires source maps for proper JS grouping.

### AI-Enhanced Grouping (Optional Layer)
Uses a transformer-based text embedding model to identify semantically similar errors. Only groups NEW issues; never splits existing fingerprint-grouped issues. Doesn't override explicit fingerprints.

### Custom Fingerprinting Rules
Users can define rules that take precedence over built-in rules. Syntax uses `{{ default }}` placeholder to extend rather than replace defaults.

## [Honeycomb] - https://www.honeycomb.io/blog/error-analysis-honeycomb-for-frontend-observability-public-beta

### Error Analysis (Different Approach)

Honeycomb takes a **trace-first, less-algorithmic** approach than Sentry:

- Groups errors with LABELS like "TypeError: undefined is not a function"
- Not a deterministic hash — uses message + type as the main discriminators
- Filter by: message, type, count, last-seen timestamp
- Integration with traces: click error count → see underlying traces → bubble up outliers

**Key insight for Chorus**: Honeycomb treats error grouping as a query/aggregation problem over structured events, not a hash-based fingerprint. This complements Sentry's approach.

**Takeaway**: We should emit errors as structured events with discrete fields (integration, operation, errorClass) so they can be BOTH hashed (Sentry-style) AND aggregated (Honeycomb-style).

