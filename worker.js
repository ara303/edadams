import { EmailMessage } from "cloudflare:email";

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildRawEmail({ from, to, subject, text, html, replyTo }) {
  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const safeSubject = String(subject).replace(/\r|\n/g, " ");
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${safeSubject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${from.split("@")[1] || "edadams.io"}>`,
    `Date: ${new Date().toUTCString()}`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    text,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    html,
    ``,
    `--${boundary}--`,
  ]
    .filter((v) => v !== null)
    .join("\r\n");
  return headers;
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

const rateLimitMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000; // 1 hour
  const max = 10; // 10 submissions per hour per IP
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count += 1;
  if (entry.count > max) return true;
  return false;
}

async function parseBody(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return await request.json();
  }
  if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
    const fd = await request.formData();
    return Object.fromEntries(fd.entries());
  }
  try {
    const fd = await request.formData();
    if ([...fd.keys()].length) return Object.fromEntries(fd.entries());
  } catch {}
  try {
    return await request.json();
  } catch {}
  return {};
}

async function verifyTurnstile(token, ip, env) {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.error("TURNSTILE_SECRET_KEY is not configured – set it with `wrangler secret put TURNSTILE_SECRET_KEY`");
    return { ok: false, configured: false, error: "Verification is not configured. Please email directly." };
  }

  const body = new URLSearchParams({ secret, response: token });
  if (ip && ip !== "unknown") body.append("remoteip", ip);

  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    const outcome = await res.json().catch(() => ({}));
    if (!outcome.success) {
      return { ok: false, configured: true, errorCodes: outcome["error-codes"] || [] };
    }
    // Optional: pin the widget action so tokens from other forms can't be reused
    if (outcome.action && outcome.action !== "contact") {
      return { ok: false, configured: true, errorCodes: ["action-mismatch"] };
    }
    return { ok: true, configured: true };
  } catch (e) {
    console.error("Turnstile siteverify request failed:", e);
    return { ok: false, configured: true, error: "Verification service unavailable. Please try again." };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Block direct access to worker source and dotfiles
    if (url.pathname === "/worker.js" || url.pathname.startsWith("/.dev.vars")) {
      return new Response("Not found", { status: 404 });
    }

    // --- API: POST /api/contact ---
    if (url.pathname === "/api/contact") {
      // CORS preflight (same-origin, but allow tooling)
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "86400",
          },
        });
      }

      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed. Use POST." }, 405, {
          Allow: "POST, OPTIONS",
        });
      }

      // Rate limit by IP
      const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";
      if (isRateLimited(ip)) {
        return jsonResponse({ error: "Too many requests. Please try again later." }, 429);
      }

      let data;
      try {
        data = await parseBody(request);
      } catch (e) {
        return jsonResponse({ error: "Invalid request body." }, 400);
      }

      // Cloudflare Turnstile – verify the challenge token before doing anything else
      const turnstileToken = String(data.turnstileToken || data["cf-turnstile-response"] || "").trim();
      if (!turnstileToken) {
        return jsonResponse({ error: "Please complete the verification challenge." }, 400);
      }
      const turnstile = await verifyTurnstile(turnstileToken, ip, env);
      if (!turnstile.ok) {
        if (turnstile.errorCodes && turnstile.errorCodes.length) {
          console.warn("Turnstile verification failed:", turnstile.errorCodes.join(", "));
        }
        return jsonResponse(
          { error: turnstile.error || "Verification failed. Please try again." },
          turnstile.configured === false ? 500 : 403
        );
      }

      const name = String(data.name || "").trim();
      const info = String(data.info || data.email || data.contact || "").trim(); // support legacy field names
      const message = String(data.message || "").trim();

      // Validation
      const errors = {};
      if (!name || name.length < 2) errors.name = "Name is required (at least 2 characters).";
      if (name.length > 100) errors.name = "Name must be 100 characters or fewer.";
      if (!info || info.length < 3) errors.info = "Email or phone number is required.";
      if (info.length > 200) errors.info = "Contact info must be 200 characters or fewer.";
      if (message.length > 5000) errors.message = "Message must be 5000 characters or fewer.";

      if (Object.keys(errors).length) {
        return jsonResponse({ error: "Validation failed.", fields: errors }, 400);
      }

      // Config – allow override via env vars, fallback to wrangler vars
      const toEmail = env.CONTACT_TO_EMAIL || "edadams101@gmail.com";
      const fromEmail = env.CONTACT_FROM_EMAIL || "no-reply@edadams.io";
      const fromName = env.CONTACT_FROM_NAME || "Ed Adams";
      const subjectPrefix = env.CONTACT_SUBJECT_PREFIX || "edadams.io - contact form";

      // Detect if `info` looks like an email for Reply-To
      const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(info);
      const replyTo = looksLikeEmail ? info : null;

      const emailSubject = `${subjectPrefix} from ${name}`;
      const textBody = [
        `New contact form submission via edadams.io`,
        ``,
        `Name: ${name}`,
        `Contact: ${info}`,
        `IP: ${ip}`,
        `Time: ${new Date().toISOString()}`,
        `URL: ${request.headers.get("Referer") || request.headers.get("Origin") || "https://edadams.io/contact"}`,
        ``,
        `Message:`,
        `${message || "(no message provided)"}`,
        ``,
        `--`,
        `Reply-To will be set to the sender's email if provided.`,
      ].join("\n");

      const htmlBody = `<!doctype html>
<html><body style="font-family:sans-serif; color:#222; line-height:1.6; max-width:640px;">
  <h2 style="margin:0 0 12px; font-size:18px;">New contact form submission — edadams.io</h2>
  <table cellpadding="6" cellspacing="0" style="border-collapse:collapse; width:100%;">
    <tr><td style="font-weight:bold; width:140px; background:#f5f5f5;">Name</td><td>${escapeHtml(name)}</td></tr>
    <tr><td style="font-weight:bold; background:#f5f5f5;">Contact</td><td>${escapeHtml(info)} ${replyTo ? `<span style="color:#666">(email – reply-to set)</span>` : ""}</td></tr>
    <tr><td style="font-weight:bold; background:#f5f5f5;">IP</td><td>${escapeHtml(ip)}</td></tr>
    <tr><td style="font-weight:bold; background:#f5f5f5;">Time</td><td>${escapeHtml(new Date().toISOString())}</td></tr>
  </table>
  <div style="margin-top:16px; padding:12px; background:#f9f9f9; border:1px solid #e5e5e5; border-radius:6px;">
    <div style="font-weight:bold; margin-bottom:6px;">Message</div>
    <div style="white-space:pre-wrap;">${escapeHtml(message || "(no message provided)")}</div>
  </div>
  <p style="color:#888; font-size:12px; margin-top:16px;">Sent via Cloudflare Workers Email binding. Reply-To: ${replyTo ? escapeHtml(replyTo) : "(no email – reply manually using contact info)"}.</p>
</body></html>`;

      const fromHeader = `${fromName} <${fromEmail}>`;

      try {
        if (!env.EMAIL) {
          console.error("EMAIL binding missing – check wrangler.jsonc send_email config");
          return jsonResponse(
            { error: "Email service not configured. Please email directly." },
            500
          );
        }

        const raw = buildRawEmail({
          from: fromHeader,
          to: toEmail,
          subject: emailSubject,
          text: textBody,
          html: htmlBody,
          replyTo,
        });

        const emailMessage = new EmailMessage(fromEmail, toEmail, raw);
        await env.EMAIL.send(emailMessage);

        return jsonResponse({ success: true, message: "Message sent! Thank you — I'll respond as soon as I can." });
      } catch (err) {
        console.error("Failed to send contact email:", err);
        // Do not leak internal details to client
        const msg = err && err.message ? err.message : String(err);
        console.error(msg);
        return jsonResponse(
          { error: "Failed to send message. Please try again later or email directly." },
          502
        );
      }
    }

    // --- Fallback: serve static assets (Cloudflare Workers Assets) ---
    // If running with `assets.directory`, Cloudflare serves assets automatically.
    // In wrangler dev the ASSETS binding may be available – try it before 404.
    if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
      try {
        // Let assets handle the request; clone URL to avoid mutation issues
        const assetRes = await env.ASSETS.fetch(request);
        // If assets returns 404 and we have SPA fallback, serve /index.html for extensionless routes
        // But respect explicit 404 for API-like paths
        if (assetRes.status !== 404) return assetRes;
        // Only fallback to index.html for GET html navigation requests
        if (request.method === "GET" && !url.pathname.includes(".") && !url.pathname.startsWith("/api/")) {
          const indexReq = new Request(new URL("/index.html", url).toString(), request);
          const indexRes = await env.ASSETS.fetch(indexReq);
          if (indexRes.status !== 404) return indexRes;
        }
        return assetRes;
      } catch (e) {
        // fall through to 404
        console.error("ASSETS.fetch error:", e);
      }
    }

    // If no assets binding (e.g. in some local setups), return 404
    // Cloudflare will still serve static assets via its own handler if this worker
    // is deployed with `assets` – this branch is mainly for local wrangler dev edge cases.
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  },
};
