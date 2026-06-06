// Bedrock InvokeModel — SigV4-signed POST routed through Cloudflare AI Gateway.
//
// AWS Bedrock's HTTPS hostname is `bedrock-runtime.<region>.amazonaws.com`, but
// AI Gateway exposes a forwarder at
// `gateway.ai.cloudflare.com/v1/<acct>/<gw>/aws-bedrock/bedrock-runtime/<region>/model/<modelId>/invoke`
// that takes the same Bedrock body and the same SigV4-signed AWS headers and
// forwards them to AWS verbatim. SigV4 signs against the ORIGINAL AWS hostname
// (`bedrock-runtime.<region>.amazonaws.com`), then the request is `fetch()`-d
// at the gateway URL — the gateway doesn't re-sign in this BYOC mode, it
// just adds caching + observability + per-org cost dashboards.
//
// Why we always route through the gateway rather than offering a direct fallback:
// the operator already has an AI Gateway provisioned for `pr-review`'s
// Anthropic-via-Workers-AI path, and the gateway adds zero cost (the AWS
// invocation is the same; the gateway is observability sugar). Pinning to
// the gateway URL means one URL pattern, one place to monitor model spend,
// and the BYOC trust path stays intact (gateway doesn't see AWS creds — they
// ride in the SigV4 Authorization header it forwards).
//
// Spec: specs/05-byoc.md § AWS federation; CF docs:
// https://developers.cloudflare.com/ai-gateway/usage/providers/bedrock/

/** Short-lived AWS credentials minted by `awsAssumeRole`. */
export type AwsCreds = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
};

/** Inputs to one Bedrock InvokeModel call. */
export type BedrockInvokeInput = {
  readonly creds: AwsCreds;
  readonly region: string;
  readonly modelId: string;
  /** Anthropic-on-Bedrock body (`{anthropic_version, system, messages, ...}`). */
  readonly body: unknown;
  /** Cloudflare account id — first segment of the gateway URL. */
  readonly cloudflareAccountId: string;
  /** AI Gateway slug — second segment of the gateway URL. */
  readonly gatewayId: string;
  /**
   * Optional `cf-aig-authorization` token (only when the operator's gateway
   * has [Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)
   * turned on). Orthogonal to the AWS SigV4 signature.
   */
  readonly gatewayAuthToken?: string;
  /** Optional fetch override for tests. */
  readonly fetchImpl?: typeof fetch;
};

/** What InvokeModel returns — the response text + token usage when present. */
export type BedrockInvokeResult = {
  /** Concatenated text from the response's `content[].text` blocks. */
  readonly response: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
};

/**
 * SigV4-sign + POST a Bedrock InvokeModel request. The signature targets the
 * ORIGINAL AWS hostname (`bedrock-runtime.<region>.amazonaws.com`); the actual
 * `fetch()` goes to the AI Gateway URL with those same signed headers — the
 * gateway forwards the request to AWS verbatim. Throws on non-2xx with the
 * response body inlined (truncated) so the caller's error boundary can name
 * the cause.
 */
export const invokeBedrockViaAiGateway = async (
  input: BedrockInvokeInput,
): Promise<BedrockInvokeResult> => {
  const awsHost = `bedrock-runtime.${input.region}.amazonaws.com`;
  // SigV4 canonical URI requires path segments URL-encoded TWICE for canonical
  // signing. For an inference-profile id like `us.anthropic.claude-opus-4-6-v1`
  // the encoding is a no-op; for ids with `:` (older versioned ARNs) the
  // colon goes `:` → `%3A` (wire URL) → `%253A` (canonical).
  const wirePath = `/model/${encodeURIComponent(input.modelId)}/invoke`;
  const canonicalPath = `/model/${encodeURIComponent(encodeURIComponent(input.modelId))}/invoke`;
  const payload = JSON.stringify(input.body);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const algorithm = "AWS4-HMAC-SHA256";
  const service = "bedrock";
  const credentialScope = `${dateStamp}/${input.region}/${service}/aws4_request`;

  const payloadHash = await sha256Hex(payload);

  // The signed `host` header MUST be the AWS hostname even though the request
  // goes to the gateway — AWS validates the signature against this value, and
  // the gateway forwards the header pair through unchanged.
  const canonicalHeaders =
    `host:${awsHost}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-security-token:${input.creds.sessionToken}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date;x-amz-security-token";

  const canonicalRequest =
    `POST\n${canonicalPath}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const stringToSign =
    `${algorithm}\n${amzDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;

  const signingKey = await deriveSigningKey(
    input.creds.secretAccessKey,
    dateStamp,
    input.region,
    service,
  );
  const signature = await hmacHex(signingKey, stringToSign);

  const authorization =
    `${algorithm} Credential=${input.creds.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const gatewayUrl =
    `https://gateway.ai.cloudflare.com/v1/${input.cloudflareAccountId}/${input.gatewayId}` +
    `/aws-bedrock/bedrock-runtime/${input.region}${wirePath}`;
  const doFetch = input.fetchImpl ?? fetch;

  const headers: Record<string, string> = {
    host: awsHost,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    "x-amz-security-token": input.creds.sessionToken,
    authorization,
    "content-type": "application/json",
    accept: "application/json",
  };
  if (input.gatewayAuthToken !== undefined) {
    // Authenticated Gateway — gates access to the gateway itself, not to AWS.
    headers["cf-aig-authorization"] = `Bearer ${input.gatewayAuthToken}`;
  }

  const res = await doFetch(gatewayUrl, {
    method: "POST",
    headers,
    body: payload,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Bedrock InvokeModel via AI Gateway failed: HTTP ${res.status} — ${text.slice(0, 500)}`,
    );
  }

  // Anthropic-on-Bedrock body shape:
  //   { content: [{type:"text", text:"..."}],
  //     usage: { input_tokens, output_tokens }, ... }
  const json = (await res.json()) as {
    content?: ReadonlyArray<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const response = (json.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");

  const result: BedrockInvokeResult = {
    response,
    ...(json.usage?.input_tokens !== undefined
      ? { inputTokens: json.usage.input_tokens }
      : {}),
    ...(json.usage?.output_tokens !== undefined
      ? { outputTokens: json.usage.output_tokens }
      : {}),
  };
  return result;
};

// --- SubtleCrypto helpers (no AWS SDK) ---------------------------------------

const sha256Hex = async (data: string): Promise<string> => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const hmac = async (key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> => {
  const k = await crypto.subtle.importKey(
    "raw",
    key as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
};

const hmacHex = async (key: ArrayBuffer, msg: string): Promise<string> => {
  const buf = await hmac(key, msg);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const deriveSigningKey = async (
  secret: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> => {
  const kDate = await hmac(new TextEncoder().encode(`AWS4${secret}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
};
