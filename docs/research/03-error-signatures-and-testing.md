# Research 03: Error Signatures, Redaction, and Snapshot Testing
Agent: scout-charlie
Started: 2026-04-13T00:00:00Z

## Progress Tracker
- [x] Sentry fingerprinting algorithm
- [x] Honeycomb error grouping
- [x] Stable signature generation principles
- [x] Presidio / OWASP PII detection
- [x] Sentry beforeSend data scrubbers
- [ ] Structured logging patterns
- [ ] GDPR pseudonymization
- [x] VCR cassette pattern
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

## [Microsoft Presidio] - https://microsoft.github.io/presidio/ and https://github.com/microsoft/presidio

### Architecture Overview

Presidio is an open-source framework for detecting, redacting, masking, and anonymizing PII across text, images, and structured data. Two main components:

**1. AnalyzerEngine** (PII detection):
- Entry point for detecting PII entities
- Orchestrates detection using RecognizerRegistry + NLP engine
- Returns `RecognizerResult` objects with entity type, confidence score, text position

**2. AnonymizerEngine** (PII removal):
- Applies operators (redact, replace, mask, hash, encrypt) to detected PII

### Detection Mechanisms

- **Pattern-based** (`PatternRecognizer`): regex with context words + validation logic
- **Machine Learning**: NER models (spaCy, Stanza, Hugging Face Transformers)
- **Rule-based**: custom logic combining multiple mechanisms
- **Context-aware** (`ContextAwareEnhancer`): uses surrounding text to improve detection

### Basic API Example
```python
from presidio_analyzer import AnalyzerEngine

analyzer = AnalyzerEngine()
results = analyzer.analyze(
    text="My phone number is 212-555-5555",
    entities=["PHONE_NUMBER"],
    language='en'
)
```

### Entity Types (Predefined)
Presidio supports entities like: CREDIT_CARD, CRYPTO, DATE_TIME, EMAIL_ADDRESS, IBAN_CODE, IP_ADDRESS, LOCATION, PERSON, PHONE_NUMBER, URL, US_SSN, US_BANK_NUMBER, US_DRIVER_LICENSE, US_ITIN, US_PASSPORT, MEDICAL_LICENSE, plus custom.

### For Chorus
- Presidio is Python-only for now — would need a TypeScript equivalent or subprocess bridge
- Alternative: use simpler regex-based allowlist (our primary approach) and consider Presidio as an optional deep-scan layer

## [Sentry beforeSend Hooks] - https://docs.sentry.io/platforms/javascript/data-management/sensitive-data/

### Two-Layer Defense

Sentry recommends a two-layer approach:
1. **SDK-level** (`beforeSend` hook): scrub before data leaves local environment — **preferred**
2. **Server-side scrubbing**: redact just before saving in Sentry

### Example beforeSend
```javascript
Sentry.init({
  dsn: "___PUBLIC_DSN___",
  beforeSend(event) {
    if (event.user) {
      delete event.user.email;
    }
    return event;
  },
});
```

### Advanced Data Scrubbing
Sentry also offers server-side rules with custom regex matching on specific parts of the event — useful for patterns you might miss client-side.

### Key Lesson for Chorus
- **Always redact at the edge (client-side)** — never rely solely on server-side scrubbing
- Use a **schema-gated `beforeSend` equivalent** — only allowlisted fields pass through

## [OWASP Logging Cheat Sheet] - https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html

### What OWASP Says NEVER To Log

- Health data, government identifiers, vulnerable-people data
- **Authentication credentials** (passwords)
- **Payment data** (bank accounts, card holder data)
- **Session identification values** (use hashed value if tracking needed)
- **Access tokens, secrets**, encryption keys, connection strings
- Legally restricted data in the jurisdiction

### Approach: Consent-Based

> "Never log data unless it is legally sanctioned."

Must exclude data users have opted out of collection.

### De-identification Techniques
- **Deletion**: remove the field entirely
- **Scrambling**: randomize but keep shape
- **Pseudonymization**: replace direct/indirect identifiers with stable tokens

### Structured Logging > String Logging
- Key/value pairs are easier to detect & evaluate
- Allowlist new attributes before they get logged
- Middleware can mask/scrub sensitive fields whose keys match a blocklist BEFORE write
- OpenTelemetry Collector can scrub at pipeline stage as defense-in-depth

### Takeaway for Chorus
- **Use STRUCTURED logs** — not string interpolation
- **Allowlist**: only explicitly-approved fields get logged
- **Blocklist**: additional regex-based backup filter
- **Multi-stage redaction**: client SDK → aggregation layer → storage

## [VCR / VCR.py / Polly.JS / MSW] - https://github.com/vcr/vcr, https://vcrpy.readthedocs.io, https://github.com/Netflix/pollyjs, https://mswjs.io/

### Comparison Matrix

| Tool | Language | Format | Approach | Primary Use |
|------|----------|--------|----------|-------------|
| **VCR** (Ruby) | Ruby | YAML cassettes | Record/replay HTTP interactions | Original pattern; test suite determinism |
| **VCR.py** | Python | YAML cassettes | Decorator-based record/replay | Python HTTP tests |
| **Polly.JS** | JS (Browser + Node) | HAR (HTTP Archive) JSON | Record/replay with taps into multiple request APIs | Cross-env JS record/replay |
| **MSW** (Mock Service Worker) | JS (Browser + Node) | Programmatic handlers (no file) | Request handlers, service-worker interception | Explicit, intentional mocking |

### VCR Philosophy (Original)
- First run: records all HTTP interactions → serialized to cassette file
- Subsequent runs: intercepts matching requests → returns recorded responses
- Tests become **fast, deterministic, accurate** (real responses replayed)

### VCR.py Key Features
- **Cassette format**: YAML (human-readable, diffable)
- Decorator: `@vcr.use_cassette('fixtures/vcr_cassettes/synopsis.yaml')`
- Context manager: `with vcr.use_cassette(...):`
- Match on: method, URI, body, headers (configurable)
- Record modes: `once`, `none`, `new_episodes`, `all`

### Polly.JS Key Features
- Uses **HAR format** (standard HTTP Archive)
- Framework-agnostic
- Taps into multiple APIs: Fetch, XHR, Node HTTP(S)
- Recording modes: record, replay, passthrough, stopped

### MSW Key Differences
- **No recording**: handlers are written explicitly
- Uses Service Worker API (browser) or class extension (Node)
- "Single source of truth for network behavior"
- Better for intentional API contracts vs. opportunistic recording

### Key Insight for Chorus
- **Cassette-based recording (VCR.py, Polly)** is ideal for capturing integration responses AS THEY CHANGE
- **MSW-style explicit handlers** are better for stable contract testing
- Chorus needs BOTH: record real failures (cassettes) AND define expected shapes (schemas)
- **Cassette format should be portable** — YAML or HAR, not language-specific

