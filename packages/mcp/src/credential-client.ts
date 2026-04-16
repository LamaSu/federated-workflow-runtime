/**
 * @chorus/mcp — credential-client
 *
 * HTTP-based `CredentialService` implementation for STANDALONE MCP
 * scaffolds. Generated `index.js` files can use this to delegate
 * credential management to a live Chorus runtime elsewhere on the
 * network (typically http://127.0.0.1:3000).
 *
 *   import { HttpCredentialServiceClient } from "@chorus/mcp/credential-client";
 *
 *   const credentialService = new HttpCredentialServiceClient({
 *     baseUrl: process.env.CHORUS_RUNTIME_URL ?? "http://127.0.0.1:3000",
 *     apiToken: process.env.CHORUS_API_TOKEN,
 *   });
 *
 *   await serveIntegration({ integration, credentialService });
 *
 * If CHORUS_RUNTIME_URL is unset and the scaffold still wires the
 * client, it fails fast with a clear message rather than spinning on
 * network errors — the `index.js` template decides whether to wire.
 */
import type {
  CredentialService,
  CredentialSummary,
  CredentialTestResultView,
} from "./server.js";

export interface HttpCredentialServiceClientOptions {
  /**
   * Base URL of the Chorus runtime — scheme + host + optional port,
   * NO trailing slash. e.g. "http://127.0.0.1:3000".
   */
  baseUrl: string;
  /**
   * Bearer token the runtime enforces on /api/*. Omit when the runtime
   * is relying on 127.0.0.1 binding for security.
   */
  apiToken?: string | null;
  /** Override fetch — primarily for tests. */
  fetchFn?: typeof fetch;
  /**
   * AbortSignal propagation — pass through to every HTTP call so MCP
   * session cancellation aborts in-flight requests.
   */
  signal?: AbortSignal;
}

export class HttpCredentialServiceClient implements CredentialService {
  private readonly baseUrl: string;
  private readonly apiToken: string | null;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: HttpCredentialServiceClientOptions) {
    if (!opts.baseUrl) {
      throw new Error("HttpCredentialServiceClient: baseUrl is required");
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiToken = opts.apiToken ?? null;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async list(integration: string): Promise<CredentialSummary[]> {
    const url = new URL(`${this.baseUrl}/api/credentials`);
    url.searchParams.set("integration", integration);
    const res = await this.fetchFn(url, {
      method: "GET",
      headers: this.headers(),
      signal: this.opts.signal,
    });
    await this.ensureOk(res, "list");
    const body = (await res.json()) as { credentials: CredentialSummary[] };
    return body.credentials;
  }

  async configure(args: {
    integration: string;
    credentialTypeName: string;
    name: string;
    fields: Record<string, unknown>;
  }): Promise<{ id: string; name: string }> {
    const res = await this.fetchFn(`${this.baseUrl}/api/credentials`, {
      method: "POST",
      headers: this.headers("application/json"),
      body: JSON.stringify(args),
      signal: this.opts.signal,
    });
    await this.ensureOk(res, "configure");
    return (await res.json()) as { id: string; name: string };
  }

  async authenticate(args: {
    integration: string;
    credentialTypeName: string;
    name: string;
  }): Promise<{ authorizeUrl: string; credentialId?: string }> {
    const res = await this.fetchFn(
      `${this.baseUrl}/api/credentials/authenticate`,
      {
        method: "POST",
        headers: this.headers("application/json"),
        body: JSON.stringify(args),
        signal: this.opts.signal,
      },
    );
    await this.ensureOk(res, "authenticate");
    const body = (await res.json()) as {
      authorizeUrl: string;
      state: string;
      expiresAt: string;
    };
    return { authorizeUrl: body.authorizeUrl };
  }

  async testAuth(args: {
    integration: string;
    credentialId: string;
  }): Promise<CredentialTestResultView> {
    const res = await this.fetchFn(
      `${this.baseUrl}/api/credentials/${encodeURIComponent(args.credentialId)}/test`,
      {
        method: "POST",
        headers: this.headers("application/json"),
        body: JSON.stringify({ integration: args.integration }),
        signal: this.opts.signal,
      },
    );
    await this.ensureOk(res, "testAuth");
    return (await res.json()) as CredentialTestResultView;
  }

  private headers(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (contentType) headers["Content-Type"] = contentType;
    if (this.apiToken) headers.Authorization = `Bearer ${this.apiToken}`;
    return headers;
  }

  private async ensureOk(res: Response, op: string): Promise<void> {
    if (res.ok) return;
    let body = "";
    try {
      body = await res.text();
    } catch {
      // ignore
    }
    throw new Error(
      `HttpCredentialServiceClient.${op}: runtime returned ${res.status} ${body.slice(0, 200)}`,
    );
  }
}
