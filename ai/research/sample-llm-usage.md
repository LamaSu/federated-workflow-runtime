# Sample LLM Integration Usage

*implementer-charlie, 2026-04-22.*

Three first-party LLM integrations ship with Chorus:

| Package | Node `integration` | Default model |
|---------|--------------------|---------------|
| `@delightfulchorus/integration-llm-anthropic` | `llm-anthropic` | `claude-sonnet-4-5` |
| `@delightfulchorus/integration-llm-openai` | `llm-openai` | `gpt-4o-mini` |
| `@delightfulchorus/integration-llm-gemini` | `llm-gemini` | `gemini-2.0-flash-exp` |

Each exposes two operations with an IDENTICAL input/output contract — so a
workflow can swap providers without rewiring nodes (only `integration` and
optionally `model` change).

## Operations

### `generate` — text completion

**Input**

```jsonc
{
  "prompt": "string (required, non-empty)",
  "system": "string (optional)",
  "model": "string (optional; falls back to provider default)",
  "temperature": 0.0-2.0,         // optional
  "maxTokens": 1..200000          // optional
}
```

**Output**

```jsonc
{
  "text": "string",
  "usage": { "inputTokens": 0, "outputTokens": 0 },
  "finishReason": "stop" | "length" | "tool-calls" | "content-filter" | "error" | "other" | "unknown"
}
```

### `generateObject` — structured JSON

Input is the same as `generate`, plus a `schema` (JSON Schema) that describes the desired output shape. Output replaces `text` with a validated `object: unknown`.

```jsonc
{
  "prompt": "Extract a person from: 'Alice is 30.'",
  "schema": {
    "type": "object",
    "properties": {
      "name": { "type": "string" },
      "age":  { "type": "number" }
    },
    "required": ["name", "age"],
    "additionalProperties": false
  }
}
```

Returns

```jsonc
{
  "object": { "name": "Alice", "age": 30 },
  "usage": { "inputTokens": 12, "outputTokens": 14 },
  "finishReason": "stop"
}
```

## Credentials

All three integrations use `authType: "apiKey"` with a single field:

| Integration | Credential type name | Field | Where to get it |
|-------------|----------------------|-------|------------------|
| llm-anthropic | `anthropicApiKey` | `apiKey` (pattern `^sk-ant-`) | <https://console.anthropic.com/settings/keys> |
| llm-openai | `openaiApiKey` | `apiKey` (pattern `^sk-`) | <https://platform.openai.com/api-keys> |
| llm-gemini | `googleAiStudioApiKey` | `apiKey` | <https://aistudio.google.com/app/apikey> |

Add a credential once with the CLI:

```sh
$ chorus credentials add
? Integration: llm-anthropic
? Credential type: anthropicApiKey (Anthropic API Key)
? API Key: **********************
✓ Stored. Run `chorus credentials test <id>` to validate.
```

## Example workflow — text generation

```json
{
  "id": "wf-summarize-001",
  "name": "Summarize incoming text",
  "version": 1,
  "active": true,
  "trigger": { "type": "manual" },
  "nodes": [
    {
      "id": "summarize",
      "integration": "llm-anthropic",
      "operation": "generate",
      "config": { "credentialId": "<id-of-anthropic-credential>" },
      "inputs": {
        "system": "You summarize text in ONE sentence of at most 25 words.",
        "prompt": "{{trigger.text}}",
        "maxTokens": 80,
        "temperature": 0.3
      }
    }
  ],
  "connections": [],
  "createdAt": "2026-04-22T00:00:00Z",
  "updatedAt": "2026-04-22T00:00:00Z"
}
```

The same node works against OpenAI by changing `integration` to `llm-openai`, and against Gemini by changing it to `llm-gemini`. No other node fields need to change.

## Example workflow — structured extraction via `generateObject`

```json
{
  "id": "wf-invoice-extract-001",
  "name": "Extract invoice fields",
  "version": 1,
  "active": true,
  "trigger": { "type": "manual" },
  "nodes": [
    {
      "id": "extract",
      "integration": "llm-openai",
      "operation": "generateObject",
      "config": { "credentialId": "<id-of-openai-credential>" },
      "inputs": {
        "system": "Extract structured invoice data. Return only fields you are certain about.",
        "prompt": "{{trigger.rawText}}",
        "model": "gpt-4o",
        "schema": {
          "type": "object",
          "properties": {
            "invoiceNumber":  { "type": "string" },
            "totalUSD":       { "type": "number" },
            "vendor":         { "type": "string" },
            "dueDate":        { "type": "string", "format": "date" }
          },
          "required": ["invoiceNumber", "totalUSD", "vendor"],
          "additionalProperties": false
        }
      }
    }
  ],
  "connections": [],
  "createdAt": "2026-04-22T00:00:00Z",
  "updatedAt": "2026-04-22T00:00:00Z"
}
```

## Example workflow — three-provider fallback

One workflow trying Anthropic first, then OpenAI on failure, then Gemini. Uses `Connection.when?` to branch on upstream failure (planned — implementer-bravo's Task 4 work adds the runtime support).

```json
{
  "id": "wf-llm-fallback-001",
  "name": "Resilient summary with triple-provider fallback",
  "version": 1,
  "active": true,
  "trigger": { "type": "manual" },
  "nodes": [
    {
      "id": "tryAnthropic",
      "integration": "llm-anthropic",
      "operation": "generate",
      "config": { "credentialId": "<anthropic-id>" },
      "inputs": {
        "prompt": "Summarize: {{trigger.text}}",
        "maxTokens": 80
      },
      "onError": "continue"
    },
    {
      "id": "tryOpenAI",
      "integration": "llm-openai",
      "operation": "generate",
      "config": { "credentialId": "<openai-id>" },
      "inputs": {
        "prompt": "Summarize: {{trigger.text}}",
        "maxTokens": 80
      },
      "onError": "continue"
    },
    {
      "id": "tryGemini",
      "integration": "llm-gemini",
      "operation": "generate",
      "config": { "credentialId": "<gemini-id>" },
      "inputs": {
        "prompt": "Summarize: {{trigger.text}}",
        "maxTokens": 80
      }
    }
  ],
  "connections": [
    { "from": "tryAnthropic", "to": "tryOpenAI", "when": "tryAnthropic.status == 'failed'" },
    { "from": "tryOpenAI",    "to": "tryGemini", "when": "tryOpenAI.status == 'failed'" }
  ],
  "createdAt": "2026-04-22T00:00:00Z",
  "updatedAt": "2026-04-22T00:00:00Z"
}
```

## Error contract

All three integrations surface the same Chorus error classes:

| Provider condition | Chorus error | Retryable? |
|---------------------|--------------|-----------|
| Missing credential | `AuthError` | No |
| HTTP 401 / 403 / "invalid api key" / "permission denied" | `AuthError` | No |
| HTTP 429 / "rate limit" / "quota exceeded" | `RateLimitError` (with `retryAfterMs` when known) | Yes |
| HTTP 5xx | `IntegrationError` | Yes |
| HTTP 4xx (non-429) | `IntegrationError` | No |

This matches the shape that slack-send, gmail-send, and http-generic use, so the repair-agent's error-signature matching works on LLM integrations out of the box.

## Credentials: what NOT to do

- Do NOT put `apiKey` in the node's `inputs` — put it on a credential and reference it via `config.credentialId`.
- Do NOT log or print `ctx.credentials`. The cassette recorder in every operation only stores shape, never the key.
- Do NOT share workflow JSON with embedded `credentialId` across machines — `credentialId` is local to the user's SQLite. Templates from `chorus share` strip these automatically.

## Out of scope for this task

- `agent` step integration — implementer-foxtrot Wave 3
- `chorus compose` NL-to-workflow CLI — implementer-bravo

## References

- Scout verdict: `ai/research/landscape-chorus-expansion-2026-04-22.md`
- Core types: `packages/core/src/types.ts`, `packages/core/src/credential-catalog.ts`
- Sibling integrations (pattern reference): `integrations/slack-send/`, `integrations/gmail-send/`
- Vercel AI SDK docs: <https://ai-sdk.dev/docs/ai-sdk-core/generating-text>, <https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data>
