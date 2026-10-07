import { EmailMessage } from "cloudflare:email";

// Must be a verified destination address in Cloudflare Email Routing,
// and FROM must be on a domain with Email Routing enabled.
const TO = "edadams101@gmail.com";
const FROM = "no-reply@edadams.io";

const json = (data, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

// UTF-8 safe base64 (btoa alone only handles Latin-1)
const b64 = (str) => {
  let bin = "";
  for (const byte of new TextEncoder().encode(str)) bin += String.fromCharCode(byte);
  return btoa(bin);
};

async function turnstileOk(token, ip, secret) {
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    return (await res.json()).success === true;
  } catch {
    return false;
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/api/contact") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    }

    // Accept JSON or form posts (HTML forms / FormData)
    let data;
    try {
      const type = request.headers.get("content-type") || "";
      data = type.includes("json")
        ? await request.json()
        : Object.fromEntries(await request.formData());
    } catch {
      return json({ error: "Invalid request body." }, 400);
    }

    const name = String(data.name ?? "").trim();
    const info = String(data.info ?? "").trim();
    const message = String(data.message ?? "").trim();
    const token = String(data.turnstileToken ?? data["cf-turnstile-response"] ?? "");

    // Cheap checks first, so junk never costs a Turnstile API call
    if (!name || name.length > 100) return json({ error: "Name is required (max 100 characters)." }, 400);
    if (!info || info.length > 200) return json({ error: "Email or phone is required (max 200 characters)." }, 400);
    if (message.length > 5000) return json({ error: "Message is too long (max 5000 characters)." }, 400);
    if (!token) return json({ error: "Please complete the verification challenge." }, 400);

    const ip = request.headers.get("cf-connecting-ip");
    if (!(await turnstileOk(token, ip, env.TURNSTILE_SECRET_KEY))) {
      return json({ error: "Verification failed. Please try again." }, 403);
    }

    const replyTo = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(info) ? info : null;

    const body = `Name: ${name}\nContact: ${info}\n\n${message || "(no message)"}\n`;

    const raw = [
      `From: Ed Adams <${FROM}>`,
      `To: ${TO}`,
      ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
      `Subject: =?UTF-8?B?${b64(`Contact form: ${name}`)}?=`,
      `Message-ID: <${crypto.randomUUID()}@${FROM.split("@")[1]}>`,
      `Date: ${new Date().toUTCString()}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=UTF-8`,
      `Content-Transfer-Encoding: base64`,
      ``,
      b64(body).match(/.{1,76}/g).join("\r\n"),
    ].join("\r\n");

    try {
      await env.EMAIL.send(new EmailMessage(FROM, TO, raw));
      return json({ success: true, message: "Message sent! Thank you." });
    } catch (err) {
      console.error("Send failed:", err);
      return json({ error: "Failed to send message. Please try again later." }, 502);
    }
  },
};
