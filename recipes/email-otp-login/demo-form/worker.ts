// Generic OTP auth demo — the `email-otp-login` recipe's live target.
//
// A tiny, self-contained OTP login API + form so you can run `email-otp-login`
// end-to-end against something you control. Two endpoints the run drives:
//
//   POST /api/auth/otp/start  { email }         → mints a 6-digit code, stores
//                                                  it (KV, 10-min TTL), emails it.
//   POST /api/auth/otp/verify { email, code }   → 200 if the code matches, else 401.
//
// THE SENDER CONSTRAINT (read this): Cloudflare's `send_email` binding can only
// deliver to addresses VERIFIED as Email Routing destinations — it CANNOT email
// the disposable `demo-…@inbox` addresses this recipe provisions. So this demo
// sends via a third-party transactional API (Resend) from a DKIM-signed domain,
// which Email Routing then RECEIVES into the catch-all (inbound has no
// verified-destination constraint). Set RESEND_API_KEY + RESEND_FROM. Without
// them the code is returned in the start response (`devCode`) so you can still
// smoke the API offline — but that path does NOT exercise the email receive
// loop, which is the whole point. See ../README.md.

export interface Env {
  /** KV namespace storing `email → code` with a TTL. */
  OTP_KV: KVNamespace;
  /** Resend API key (transactional sender that can reach the catch-all). */
  RESEND_API_KEY?: string;
  /** Verified DKIM-signed From address on the Resend account. */
  RESEND_FROM?: string;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const FORM_HTML = `<!doctype html><meta charset="utf-8"><title>OTP demo</title>
<h1>Sign in</h1>
<form id="start"><input name="email" type="email" placeholder="you@example.com" required>
<button>Email me a code</button></form>
<form id="verify" hidden><input name="code" placeholder="6-digit code" required>
<button>Verify</button></form>
<pre id="out"></pre>
<script>
const out=document.getElementById('out'); let email='';
start.onsubmit=async e=>{e.preventDefault();email=start.email.value;
  const r=await fetch('/api/auth/otp/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});
  out.textContent='start → '+r.status; start.hidden=true; verify.hidden=false;};
verify.onsubmit=async e=>{e.preventDefault();
  const r=await fetch('/api/auth/otp/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,code:verify.code.value})});
  out.textContent='verify → '+r.status+(r.ok?' ✅ signed in':' ❌');};
</script>`;

const sendEmail = async (env: Env, to: string, code: string): Promise<boolean> => {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to,
      subject: "Your verification code",
      text: `Your one-time code is ${code}. It expires in 10 minutes.`,
    }),
  });
  return res.ok;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(FORM_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/otp/start") {
      const { email } = (await request.json().catch(() => ({}))) as { email?: string };
      if (!email) return json({ error: "email required" }, 400);
      // 6-digit numeric code; crypto-random so it isn't guessable.
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, "0");
      await env.OTP_KV.put(`otp:${email.toLowerCase()}`, code, { expirationTtl: 600 });
      const sent = await sendEmail(env, email, code);
      // Without a configured sender, return the code so the API is still
      // smoke-testable (NOT the email loop — see the file header).
      return json(sent ? { ok: true } : { ok: true, devCode: code });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/otp/verify") {
      const { email, code } = (await request.json().catch(() => ({}))) as {
        email?: string;
        code?: string;
      };
      if (!email || !code) return json({ error: "email + code required" }, 400);
      const expected = await env.OTP_KV.get(`otp:${email.toLowerCase()}`);
      if (expected !== null && expected === code) {
        await env.OTP_KV.delete(`otp:${email.toLowerCase()}`); // single-use
        return json({ ok: true });
      }
      return json({ error: "invalid code" }, 401);
    }

    return json({ error: "not_found" }, 404);
  },
};
