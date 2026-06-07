// AWS Bedrock InvokeModel via Cloudflare AI Gateway — container-side twin.
//
// Mirrors `packages/runtime-cf/src/bedrock-invoke.ts` (the Worker-side helper
// pr-review's `bedrock` backend uses). Copied (not shared) because:
//   * runtime-cf is a Worker-only package and this code runs in the demo
//     sandbox container.
//   * extracting both into a shared package is a follow-up; for the V0 of
//     #114 the duplication is small (SigV4 + one body shape) and keeps the
//     blast radius of this PR contained.
// Keep the two implementations in lockstep — when one changes, change both.
//
// Dialect: Anthropic Messages on Bedrock with tool_use, since demo-agent
// drives the play loop via toolkit calls. The Worker-side helper only ships
// the text-only shape today (review uses generateText, not tools), so this
// adds the tool branch the demo path needs.
//
// Spec: specs/05-byoc.md § AWS federation; CF docs:
// https://developers.cloudflare.com/ai-gateway/usage/providers/bedrock/

/** Short-lived AWS credentials minted by `awsAssumeRole`. */
export type AwsCreds = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
};

/** One tool the model may call (Anthropic Messages tool shape). */
export type AnthropicTool = {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool's input. */
  readonly input_schema: unknown;
};

/** A message block — Anthropic Messages content blocks (text only on input). */
export type AnthropicMessage = {
  readonly role: "user" | "assistant";
  readonly content: string | ReadonlyArray<unknown>;
};

/** Tool choice — auto / required / specific tool. */
export type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string };

export type BedrockInvokeInput = {
  readonly creds: AwsCreds;
  readonly region: string;
  readonly modelId: string;
  /** System prompt (Anthropic top-level field, not a message). */
  readonly system?: string;
  readonly messages: ReadonlyArray<AnthropicMessage>;
  readonly tools?: ReadonlyArray<AnthropicTool>;
  readonly toolChoice?: AnthropicToolChoice;
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** CF account id — first segment of the gateway URL. */
  readonly cloudflareAccountId: string;
  /** AI Gateway slug — second segment of the gateway URL. */
  readonly gatewayId: string;
  /** Optional `cf-aig-authorization` token for an Authenticated Gateway. */
  readonly gatewayAuthToken?: string;
  /** Test override for `fetch`. */
  readonly fetchImpl?: typeof fetch;
};

/** One Anthropic content block in the response. */
export type AnthropicContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    };

export type BedrockInvokeResult = {
  readonly content: ReadonlyArray<AnthropicContentBlock>;
  readonly stopReason: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
};

const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";

/**
 * SigV4-sign + POST a Bedrock InvokeModel request through the AI Gateway
 * forwarder. Signature targets the AWS hostname; the gateway forwards verbatim.
 */
export const invokeBedrockViaAiGateway = async (
  input: BedrockInvokeInput,
): Promise<BedrockInvokeResult> => {
  const awsHost = `bedrock-runtime.${input.region}.amazonaws.com`;
  // SigV4 canonical URI requires double URL-encoding of path segments.
  const wirePath = `/model/${encodeURIComponent(input.modelId)}/invoke`;
  const canonicalPath = `/model/${encodeURIComponent(encodeURIComponent(input.modelId))}/invoke`;

  const body: Record<string, unknown> = {
    anthropic_version: BEDROCK_ANTHROPIC_VERSION,
    messages: input.messages,
    max_tokens: input.maxTokens ?? 4096,
  };
  if (input.system !== undefined) body["system"] = input.system;
  if (input.temperature !== undefined) body["temperature"] = input.temperature;
  if (input.tools !== undefined && input.tools.length > 0) {
    body["tools"] = input.tools;
    if (input.toolChoice !== undefined) body["tool_choice"] = input.toolChoice;
  }
  const payload = JSON.stringify(body);

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const algorithm = "AWS4-HMAC-SHA256";
  const service = "bedrock";
  const credentialScope = `${dateStamp}/${input.region}/${service}/aws4_request`;

  const payloadHash = await sha256Hex(payload);

  const canonicalHeaders =
    `host:${awsHost}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-security-token:${input.creds.sessionToken}\n`;
  const signedHeaders =
    "host;x-amz-content-sha256;x-amz-date;x-amz-security-token";

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
    headers["cf-aig-authorization"] = `Bearer ${input.gatewayAuthToken}`;
  }

  const res = await doFetch(gatewayUrl, {
    method: "POST",
    headers,
    body: payload,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Bedrock InvokeModel via AI Gateway failed: HTTP ${res.status} — ${text.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as {
    content?: ReadonlyArray<AnthropicContentBlock>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const result: BedrockInvokeResult = {
    content: json.content ?? [],
    stopReason: json.stop_reason ?? "end_turn",
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
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(data),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const hmac = async (
  key: ArrayBuffer | Uint8Array,
  msg: string,
): Promise<ArrayBuffer> => {
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
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const deriveSigningKey = async (
  secret: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> => {
  const kDate = await hmac(
    new TextEncoder().encode(`AWS4${secret}`),
    dateStamp,
  );
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
};
