(() => {
  const form = document.querySelector("#form-contact");
  if (!form) return;

  const btn = form.querySelector(".form-submit") || {};
  const success = document.querySelector("#form-success");
  const failure = document.querySelector("#form-failure");

  const show = (el, msg = "") => {
    for (const box of [success, failure]) {
      if (!box) continue;
      box.textContent = box === el ? msg : "";
      box.classList.toggle("is-visible", box === el && !!msg);
    }
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    show();

    const payload = Object.fromEntries(new FormData(form));
    if (!payload["cf-turnstile-response"]) {
      return show(failure, "Please complete the verification challenge before sending.");
    }

    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Sending…";

    let sent = false;
    try {
      const res = await fetch(form.getAttribute("action") || "/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success) {
        sent = true;
        show(success, data.message || "Sent! Thank you. I'll respond as soon as I can.");
        form.reset();
      } else {
        show(failure, data.error || `Something went wrong (HTTP ${res.status}). Please try again or email me directly.`);
      }
    } catch {
      show(failure, "Network error – please check your connection and try again.");
    } finally {
      window.turnstile?.reset();
      btn.disabled = sent;
      btn.textContent = sent ? "Sent ✓" : label;
    }
  });
})();
