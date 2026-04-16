# Research 03: Error Signatures, Redaction, and Snapshot Testing
Agent: scout-charlie
Started: 2026-04-13T00:00:00Z
Completed: 2026-04-13T00:00:00Z

## Progress Tracker
- [x] Sentry fingerprinting algorithm
- [x] Honeycomb error grouping
- [x] Stable signature generation principles
- [x] Presidio / OWASP PII detection
- [x] Sentry beforeSend data scrubbers
- [x] Structured logging patterns
- [x] GDPR pseudonymization
- [x] VCR cassette pattern
- [x] Jest snapshot testing
- [x] Contract testing (Pact)
- [x] Schema validation (Zod, JSON Schema)
- [x] Property-based + differential testing
- [x] Synthesis for Chorus

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

## [Zod v4] - https://zod.dev and https://zod.dev/api

### Core Capabilities

**Zod is TypeScript-first runtime validation** with automatic type inference. Addresses the gap where TypeScript only type-checks at compile time.

- **Runtime validation**: `.parse(input)` throws on invalid; `.safeParse(input)` returns `{success, data|error}`
- **Type inference**: `z.infer<typeof schema>` derives static type from schema
- **Tiny**: 2kb core bundle (gzipped), zero external dependencies
- **Cross-env**: Node.js and all modern browsers

### Schema Builders

```typescript
// Primitives
z.string(), z.number(), z.boolean(), z.date()

// Composition
z.object({ name: z.string(), age: z.number() })
z.array(z.string())
z.union([z.string(), z.number()])

// Discriminated unions (faster, narrower)
z.discriminatedUnion("status", [
  z.object({ status: z.literal("success"), data: z.string() }),
  z.object({ status: z.literal("error"), error: z.string() }),
])

// Refinements (custom validation)
z.string().refine(val => val.length > 5, { message: "Too short" })

// Transforms (unidirectional)
z.string().transform(val => val.length)

// Codecs (v4.1+, bidirectional encode/decode)
```

### Why Zod for Chorus
- **Single source of truth**: write schema once, get TypeScript types + runtime validation
- **Allowlist by design**: object schemas reject unknown keys by default with `.strict()`
- **Composable**: build up error signature schemas incrementally
- **Fast**: suitable for hot path (before every error emit)

## [Jest Snapshot Testing] - https://jestjs.io/docs/snapshot-testing

### Core Pattern
- Serialize test output → save to `.snap` file
- Subsequent runs compare against saved snapshot
- Failures: output changed (either bug OR intentional — review diff)

### Best Practices for API Response Snapshots

1. **Keep snapshots focused, short, readable** — overly large snapshots = noise
2. **Ensure determinism** — NO timestamps, auto-increment IDs, or machine-specific data
3. **Use custom serializers judiciously** — for specific serialization needs only
4. **Commit snapshots + review in PR** — treat as real test code
5. **Handle dynamic data** — sanitize functions with key lists (e.g. strip `user.orders[0].created_at`)
6. **Descriptive test names** — indicate purpose clearly
7. **Isolation** — mock external dependencies

### Critical for API Snapshots
- Explicitly **strip volatile fields** before snapshotting (ids, timestamps, URLs with hashes)
- OR use custom serializers that normalize these
- **Snapshot the SHAPE, not transient values**

## [Pact / Consumer-Driven Contract Testing] - https://docs.pact.io/

### Core Concept
- **Consumer writes tests** that describe what it needs from the provider
- Tests produce a **contract** (JSON file) shared with provider
- Provider runs tests against the contract to verify compatibility
- Only the parts of communication actually USED by consumers get tested

### How It Works
1. Consumer test sets expectations for API interactions (URL, request, response shape)
2. Pact generates a JSON contract from test runs
3. Contract published to **Pact Broker** (shared service)
4. Provider pulls contracts and verifies their API meets all consumer needs

### Why This Matters for Chorus
- Chorus integrations are CONSUMERS of external APIs (Stripe, Twilio, etc.)
- We can't run Pact against those providers, BUT...
- We CAN use **Pact-style contracts between Chorus nodes** (e.g. patch consumers vs producers)
- Or use the concept: record what we use from integration, diff against updates

## [Property-Based Testing] - https://github.com/dubzzz/fast-check and Hypothesis

### Core Concept
Instead of example-based tests ("given X, assert Y"), state **properties** that should hold across any valid input. Framework generates hundreds/thousands of random inputs.

### Key Frameworks

| Framework | Lang | Shrinking | Key Feature |
|-----------|------|-----------|-------------|
| **fast-check** | TS/JS | Yes | Good TypeScript integration, biased generation (both small + large values) |
| **Hypothesis** | Python | Excellent | Most mature, per-strategy shrinking, stores failing examples in DB |
| **QuickCheck** | Haskell | Original | The concept originator |

### Shrinking (Killer Feature)
When test fails, framework auto-simplifies input to MINIMAL failing case. If `[1,5,3,99,2,7]` fails, shrinking finds maybe `[99]` or `[2]` alone triggers the bug.

### When Helpful for Chorus
- Generating synthetic error signatures to test signature stability
- Testing that redaction correctly handles any random payload shape
- Verifying patch merging/conflict resolution properties

### When NOT Helpful
- Business-logic correctness (example-based still best)
- Integration testing (use VCR cassettes instead)

## [Differential Testing] - https://dl.acm.org/doi/10.1145/3395363.3397374 (Microsoft Azure paper)

### Core Concept
Run two versions of a system on the same input, compare outputs, report differences as potential regressions.

### Applied to REST APIs (Microsoft Azure case study)
- Used **RESTler** (stateful REST fuzzer) to generate request sequences
- Compared outputs between 17 versions of Azure networking APIs (2016-2019)
- Detected 14 regressions: 5 in API specs, 9 in services

### Two Types of Regressions
1. **Specification regressions**: the contract changes
2. **Service regressions**: previously-working requests break in later versions

### Key Challenges
- Abstracting over minor differences (timestamps, ephemeral IDs)
- Handling out-of-order requests
- Non-determinism

### Application to Chorus
- **After deploying a patch**, run OLD client code + NEW patch against recorded cassettes
- Compare responses, flag structural differences
- Auto-detect regressions introduced by patches before merging

## [GDPR Pseudonymization] - EDPB Guidelines 01/2025

### Legal Definition (GDPR Article 4(5))
> "The processing of personal data in such a manner that the personal data can no longer be attributed to a specific data subject without the use of additional information, provided that such additional information is kept separately and is subject to technical and organisational measures to ensure that the personal data are not attributed to an identified or identifiable natural person."

### Three-Step Process
1. **Modify the data**: replace identifying info with new identifiers
2. **Separate additional info**: keep mapping data separated from pseudonymized data
3. **Apply T&O measures**: technical and organisational controls to prevent re-attribution

### Technical Approaches
- **Tokenization** for direct identifiers (replace email with token_123)
- **Encryption** for direct identifiers
- **Hashing** for selective linkage projects
- **Generalization** for quasi-identifiers (age 37 → 30-40)

### Connection to Data Minimization
- Pseudonymization LIMITS the level of identifiability to what's necessary
- Aligns with GDPR principles of data minimization + purpose limitation

### Key Requirements for Chorus
- **Key management is CRITICAL** — the mapping must be secured separately
- **Access controls** on re-identification keys
- **Audit trail** of who accessed mapping data
- **Salt and rotate** hashes to prevent rainbow table attacks

## [JSON Schema / OpenAPI Drift] - https://json-schema.org/

### Key Tools
- **Ajv**: Popular JSON Schema validator, used by many TypeScript projects
- **openapi-schema-validator**: Validates against OpenAPI v2, v3.0.x, v3.1.x
- **Postman** / commercial tools: runtime schema assertion

### Structural Drift Detection Pattern
1. Extract response schema from OpenAPI spec
2. Compare actual API response against expected schema
3. Check for: required fields present, types match, no unexpected properties
4. Flag differences as "drift"

### Most Important Metric
**Schema validation pass/fail rate** — how often responses match intended schema

### Error Types to Track
- Missing required fields
- Incorrect data types
- Unexpected/new properties
- Value format violations (email, UUID, etc.)

---

# SYNTHESIS FOR CHORUS

## Summary: The "Detect → Redact → Submit → Validate" Pipeline

Chorus needs to:
1. **Detect** integration failures with a STABLE signature (not just the raw error string)
2. **Redact** PII / secrets before shipping to any registry
3. **Submit** structured failure reports to the patch registry
4. **Validate** candidate patches against recorded cassettes before merging

## 1. Error Signature Schema

### Design Principles (from research)
- NEVER hash the full error — too unique, every timestamp/request-ID differs
- Use **hierarchical fallback** like Sentry: stack trace → exception → message
- **Normalize** before hashing: strip volatile fields, replace numbers/timestamps
- Prefer **in-app frames only** for stack trace component
- Keep **shape over payload** — structural fingerprint, not semantic content

### Concrete Zod Schema

```typescript
import { z } from "zod";
import crypto from "node:crypto";

// Frame of a stack trace, normalized
export const StackFrameSchema = z.object({
  // File path with hash-suffixes stripped (app.a7f3b2.js -> app.js)
  filename: z.string(),
  // Function name, demangled if native
  function: z.string().optional(),
  // Line number — KEPT (it's stable across deploys of same code)
  line: z.number().optional(),
  // Module name (e.g. "@delightfulchorus/integration-stripe/src/charge.ts")
  module: z.string().optional(),
  // Whether this frame is in our code vs. library/framework
  inApp: z.boolean().default(false),
  // Source line content — normalized (trimmed, numbers->N, timestamps->T)
  contextLine: z.string().optional(),
});

// The integration identity — who/what failed
export const IntegrationIdentitySchema = z.object({
  // e.g. "stripe", "twilio", "slack"
  integration: z.string().regex(/^[a-z0-9-]+$/),
  // SDK version of the integration adapter itself
  adapterVersion: z.string(),
  // e.g. "charges.create", "messages.send"
  operation: z.string(),
});

// The error classification
export const ErrorClassSchema = z.object({
  // e.g. "ValidationError", "RateLimitError", "AuthError"
  errorClass: z.string(),
  // HTTP status if applicable (null for non-HTTP failures)
  httpStatus: z.number().int().min(100).max(599).nullable(),
  // Provider's error code (e.g. Stripe's "card_declined")
  providerCode: z.string().nullable(),
  // Provider's error type (e.g. Stripe's "invalid_request_error")
  providerType: z.string().nullable(),
});

// The normalized fingerprint components (what goes into the hash)
export const SignatureComponentsSchema = z.object({
  identity: IntegrationIdentitySchema,
  errorClass: ErrorClassSchema,
  // Top N in-app frames, normalized
  stackFingerprint: z.array(StackFrameSchema).max(10),
  // First line of the error message, with numbers/timestamps masked
  // "Charge ch_123abc failed at 2026-04-13" -> "Charge ch_N failed at T"
  messageTemplate: z.string().optional(),
}).strict();

// The final signed signature sent to the registry
export const ErrorSignatureSchema = z.object({
  // Schema version for forward compatibility
  schemaVersion: z.literal("1.0.0"),
  // Stable SHA-256 of canonicalized SignatureComponents
  signatureHash: z.string().regex(/^[a-f0-9]{64}$/),
  // Keep components for debugging/grouping on registry side
  components: SignatureComponentsSchema,
  // ISO timestamp of FIRST occurrence on this client
  firstSeen: z.string().datetime(),
  // Occurrence count on this client
  occurrenceCount: z.number().int().positive(),
  // Optional: similarity hash for fuzzy grouping (locality-sensitive)
  similarityHash: z.string().optional(),
});

export type ErrorSignature = z.infer<typeof ErrorSignatureSchema>;
export type SignatureComponents = z.infer<typeof SignatureComponentsSchema>;

// Canonical hash computation
export function computeSignatureHash(components: SignatureComponents): string {
  // Canonicalize: sort keys, no whitespace, no redundancy
  const canonical = JSON.stringify(components, Object.keys(components).sort());
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// Normalization helpers (the critical bit)
export function normalizeContextLine(line: string): string {
  return line
    .replace(/\b\d+\b/g, "N")                        // numbers -> N
    .replace(/\b\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}/g, "T")  // ISO timestamps -> T
    .replace(/\b[0-9a-f]{8,}\b/gi, "H")              // hex hashes -> H
    .replace(/\b[A-Za-z0-9]{20,}\b/g, "ID")          // long opaque IDs -> ID
    .trim();
}

export function normalizeFilename(filename: string): string {
  return filename
    .replace(/\.[a-f0-9]{6,}\.(js|ts|mjs|cjs)$/, ".$1")  // strip hash suffix
    .toLowerCase();
}
```

### Why This Works
- **Stable across benign variation**: request IDs, timestamps, numbers all masked
- **Discriminates real differences**: error class, operation, stack trace shape all preserved
- **Schema-versioned**: can evolve over time
- **Forward-compatible**: registry can group/re-group as algorithms improve
- **Debuggable**: components are preserved (not just opaque hash)

## 2. Redaction Pipeline

### Design Principles (from OWASP + Sentry)
- **Allowlist, not blocklist** — only explicitly-approved fields pass
- **Multi-stage**: SDK-level → aggregation → storage
- **Shape not payload**: emit schema of the data, not its values
- **Pseudonymize stable identifiers**: hash+salt email/user-id to enable correlation without exposure

### What We KEEP (Allowlist)
| Field | Why | Treatment |
|-------|-----|-----------|
| Integration name | Required for routing | Plain |
| Operation name | Required for grouping | Plain |
| HTTP status | Required for classification | Plain |
| Error class / provider code | Required for fingerprinting | Plain |
| Stack trace (in-app only) | Required for fingerprinting | Normalized (see above) |
| Request method + URL path | Useful for context | Path params stripped (`/users/:id`) |
| Response shape (keys only, no values) | Useful for drift detection | Structural only |
| Timing (duration_ms) | Useful for perf | Plain |
| Retry count | Useful for classification | Plain |

### What We STRIP (Always)
| Pattern | Why |
|---------|-----|
| Email addresses | PII |
| Credit card numbers | Payment data, OWASP forbids |
| Phone numbers | PII |
| API keys (any string matching `sk_`, `pk_`, `Bearer`, etc.) | Credentials |
| JWT tokens (three-segment base64 with dots) | Credentials |
| IP addresses | PII (GDPR explicit) |
| Full names (detected) | PII |
| Request body values | Too risky — shape only |
| Response body values | Too risky — shape only |
| Query string values | May contain PII |
| Cookies, auth headers | Credentials |

### Concrete Zod Redaction Schema + Implementation

```typescript
// The "clean" event that can safely leave the client
export const SafeEventSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  timestamp: z.string().datetime(),
  signature: ErrorSignatureSchema,
  context: z.object({
    // What operation we were running
    integration: z.string(),
    operation: z.string(),
    // Normalized URL path (no query, no path params filled in)
    urlTemplate: z.string().regex(/^\/[a-z0-9\/:_-]*$/i).optional(),
    httpMethod: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).optional(),
    // Structural shape of request/response — NOT values
    requestShape: z.record(z.string(), z.string()).optional(),  // {key: type-name}
    responseShape: z.record(z.string(), z.string()).optional(),
    // Retry metadata
    retryCount: z.number().int().min(0).optional(),
    durationMs: z.number().int().min(0).optional(),
  }).strict(),
  // Pseudonymous client identifier (hashed project ID)
  clientId: z.string().regex(/^[a-f0-9]{32}$/),  // SHA-256 truncated
  // NO raw payloads. Ever.
}).strict();

export type SafeEvent = z.infer<typeof SafeEventSchema>;

// Redaction regexes (the blocklist backup)
const REDACTION_PATTERNS = [
  { name: "email", pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { name: "creditcard", pattern: /\b(?:\d[ -]*?){13,19}\b/g },
  { name: "phone", pattern: /\+?\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g },
  { name: "jwt", pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { name: "sk_key", pattern: /\b(?:sk|pk|ak|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: "bearer", pattern: /Bearer\s+[A-Za-z0-9_.-]+/gi },
  { name: "ipv4", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  { name: "ssn_us", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: "aws_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
];

export function redactString(input: string): string {
  let out = input;
  for (const { name, pattern } of REDACTION_PATTERNS) {
    out = out.replace(pattern, `[REDACTED:${name.toUpperCase()}]`);
  }
  return out;
}

// Extract shape (types) from an object — recursive, bounded depth
export function extractShape(obj: unknown, depth = 0, maxDepth = 3): unknown {
  if (depth >= maxDepth) return "<truncated>";
  if (obj === null) return "null";
  if (Array.isArray(obj)) {
    return obj.length === 0 ? "[]" : [extractShape(obj[0], depth + 1, maxDepth)];
  }
  if (typeof obj === "object") {
    const shape: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as object)) {
      shape[k] = extractShape(v, depth + 1, maxDepth);
    }
    return shape;
  }
  return typeof obj;  // "string", "number", "boolean", etc.
}

// Pseudonymize a stable identifier (e.g. project ID, user ID for correlation)
export function pseudonymize(id: string, salt: string): string {
  return crypto.createHash("sha256").update(`${salt}::${id}`).digest("hex").slice(0, 32);
}
```

### Pipeline (Three Stages of Defense)

1. **Stage 1 — Chorus SDK `beforeEmit` hook** (like Sentry's beforeSend):
   - Parse event against `SafeEventSchema.strict()` — rejects unknown keys
   - Run string fields through `redactString()` regex sweep
   - Extract shapes for request/response — never ship values
   - Fail CLOSED: if validation fails, DROP the event rather than emit raw

2. **Stage 2 — Registry ingestion layer**:
   - Re-validate against schema (trust nothing)
   - Second redaction pass with updated patterns (can evolve server-side)
   - Reject events with any raw-looking payload

3. **Stage 3 — Storage encryption**:
   - At-rest encryption for the registry
   - Per-client pseudonymized correlation keys
   - Audit trail of access

## 3. Snapshot / Cassette Testing Strategy

### Why Chorus Needs This
- When a patch is submitted, we need to **validate** it against known-good and known-bad traffic
- Cassettes = recorded real-world failures the patch claims to fix
- Snapshots = structural contracts for healthy responses

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Chorus Node (Producer)                                       │
│                                                                │
│  1. Integration fails                                          │
│  2. Capture: request template + error response (redacted)     │
│  3. Compute signature hash                                     │
│  4. Produce a cassette entry: (signature, request, response)  │
│                                                                │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  Chorus Registry (Federated)                                  │
│                                                                │
│  - Stores cassettes indexed by signature hash                 │
│  - Stores PATCHES that claim to fix specific signatures       │
│  - Runs differential tests: patch against cassette            │
│                                                                │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  Chorus Node (Consumer)                                        │
│                                                                │
│  1. Hit same signature → registry proposes patch              │
│  2. Local validation: run patch against local cassettes        │
│  3. If validation passes → apply patch                         │
│  4. Monitor for new signatures → loop                          │
│                                                                │
└──────────────────────────────────────────────────────────────┘
```

### Cassette Format (HAR-like, Portable)

```typescript
export const CassetteEntrySchema = z.object({
  // The error signature this cassette is for
  signatureHash: z.string().regex(/^[a-f0-9]{64}$/),
  // Recorded interaction — normalized, redacted
  interaction: z.object({
    request: z.object({
      method: z.string(),
      urlTemplate: z.string(),  // :params not filled in
      headerNames: z.array(z.string()),  // names only, no values
      bodyShape: z.unknown().optional(),  // shape not value
    }),
    response: z.object({
      status: z.number(),
      headerNames: z.array(z.string()),
      bodyShape: z.unknown().optional(),
      bodySnippet: z.string().optional(),  // redacted first 200 chars for debugging
    }),
  }),
  // Timing info
  timestamp: z.string().datetime(),
  durationMs: z.number().int().min(0),
});

export const CassetteSchema = z.object({
  version: z.literal("1.0.0"),
  integration: z.string(),
  entries: z.array(CassetteEntrySchema),
}).strict();

export type Cassette = z.infer<typeof CassetteSchema>;
```

### Validation Strategy

**Three types of validation**, in order of rigor:

1. **Schema validation** (fast, always runs):
   - Does the patch emit responses matching the cassette's response shape?
   - Use Zod or JSON Schema — structural drift detection

2. **Snapshot validation** (medium cost):
   - Does the patch produce the SAME sanitized shape for the SAME input?
   - Jest snapshot style, but with dynamic-field stripping

3. **Differential validation** (slow, high confidence):
   - Run OLD code + NEW patch against cassette
   - Compare outputs, flag semantic differences
   - Microsoft Azure pattern (RESTler-style)

### Propagation of New Snapshots via Patch Registry
- Each patch ships with its **cassettes** (failure examples it was tested against)
- Consumer nodes RE-RUN the cassettes locally before accepting the patch
- If cassette doesn't reproduce locally, patch is still acceptable (different environment) — but flag as "untested-here"

## 4. Recommended Libraries (with Versions)

### Core (Production)
```json
{
  "dependencies": {
    "zod": "^4.0.0",
    "msw": "^2.7.0"
  }
}
```

### Testing
```json
{
  "devDependencies": {
    "vitest": "^2.1.0",
    "fast-check": "^3.23.0",
    "@pact-foundation/pact": "^13.0.0",
    "ajv": "^8.17.0",
    "ajv-formats": "^3.0.0"
  }
}
```

### Optional (PII deep scan)
- **Presidio** — Python-only, so run as sidecar microservice if needed for deep content scans. For JS/TS core pipeline, stick with regex allowlists.

### Cassette Storage Format
- **HAR 1.2** (HTTP Archive spec) — industry standard, tooling-compatible
- OR custom JSON with Zod schema above (simpler, tailored)

## 5. Signature Stability Testing

Use **property-based testing** (fast-check) to verify signature stability:

```typescript
import { fc, test } from "vitest";

test("signature is stable across benign variation", () => {
  fc.assert(fc.property(
    arbitraryError(),  // generates a synthetic error
    arbitraryTimestamp(),
    arbitraryRequestId(),
    (error, ts, rid) => {
      const sig1 = computeSignature(enrichError(error, { ts, rid }));
      const sig2 = computeSignature(enrichError(error, {
        ts: ts + 1000,           // different time
        rid: rid + "xyz",        // different request ID
      }));
      return sig1.signatureHash === sig2.signatureHash;
    }
  ));
});

test("signature discriminates real differences", () => {
  fc.assert(fc.property(
    arbitraryError(),
    arbitraryError(),
    (errorA, errorB) => {
      // If error class differs, signatures MUST differ
      fc.pre(errorA.class !== errorB.class);
      const sigA = computeSignature(errorA);
      const sigB = computeSignature(errorB);
      return sigA.signatureHash !== sigB.signatureHash;
    }
  ));
});
```

## 6. Summary: What Goes Into the Chorus Codebase

| Module | Purpose | Key exports |
|--------|---------|-------------|
| `@delightfulchorus/signature` | Error fingerprinting | `ErrorSignatureSchema`, `computeSignatureHash`, `normalizeContextLine`, `normalizeFilename` |
| `@delightfulchorus/redact` | PII / secret redaction | `SafeEventSchema`, `redactString`, `extractShape`, `pseudonymize` |
| `@delightfulchorus/cassette` | HTTP cassette record/replay | `CassetteSchema`, `record`, `replay`, `match` |
| `@delightfulchorus/validate` | Patch validation | `validateAgainstCassette`, `snapshotDiff`, `differentialTest` |
| `@delightfulchorus/sdk` | Client SDK | `beforeEmit` hook, schema-gated emission |

---

## Sources

### Fingerprinting
- Sentry Issue Grouping: https://docs.sentry.io/concepts/data-management/event-grouping/
- Sentry Fingerprint Rules: https://docs.sentry.io/concepts/data-management/event-grouping/fingerprint-rules/
- Sentry Developer Grouping: https://develop.sentry.dev/backend/application-domains/grouping/
- Sentry JavaScript Fingerprinting: https://docs.sentry.io/platforms/javascript/enriching-events/fingerprinting/
- Honeycomb Error Analysis: https://www.honeycomb.io/blog/error-analysis-honeycomb-for-frontend-observability-public-beta

### PII / Redaction
- Microsoft Presidio: https://github.com/microsoft/presidio
- Presidio Docs: https://microsoft.github.io/presidio/analyzer/
- Sentry Data Scrubbing: https://docs.sentry.io/platforms/javascript/data-management/sensitive-data/
- Sentry Advanced Data Scrubbing: https://docs.sentry.io/security-legal-pii/scrubbing/advanced-datascrubbing/
- OWASP Logging Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- OWASP Top 10:2025 A09 Logging: https://owasp.org/Top10/2025/A09_2025-Security_Logging_and_Alerting_Failures/
- EDPB Pseudonymization Guidelines: https://www.edpb.europa.eu/system/files/2025-01/edpb_guidelines_202501_pseudonymisation_en.pdf
- ENISA Pseudonymisation: https://www.enisa.europa.eu/sites/default/files/publications/Guidelines%20on%20shaping%20technology%20according%20to%20GDPR%20provisions.pdf

### Testing / Snapshots
- VCR (Ruby): https://github.com/vcr/vcr
- VCR.py: https://vcrpy.readthedocs.io/en/latest/
- Polly.JS: https://github.com/Netflix/pollyjs
- MSW: https://mswjs.io/
- Jest Snapshot Testing: https://jestjs.io/docs/snapshot-testing
- Pact Docs: https://docs.pact.io/
- fast-check: https://github.com/dubzzz/fast-check
- Hypothesis: https://hypothesis.readthedocs.io/
- Microsoft Differential Testing: https://dl.acm.org/doi/10.1145/3395363.3397374

### Schema Validation
- Zod: https://zod.dev
- JSON Schema: https://json-schema.org/
- Ajv: https://ajv.js.org/
- OpenAPI Schema Validator: https://github.com/seriousme/openapi-schema-validator

