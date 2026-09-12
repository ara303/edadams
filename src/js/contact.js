// Contact form – Cloudflare Workers (/api/contact)
(() => {
  const form = document.querySelector("#form-contact");
  if (!form) return;

  const btn = form.querySelector(".form-submit");
  const successEl = document.querySelector("#form-success");
  const failureEl = document.querySelector("#form-failure");

  function showSuccess(msg) {
    if (failureEl) {
      failureEl.textContent = "";
      failureEl.classList.remove("is-visible");
    }
    if (successEl) {
      successEl.textContent = msg || "Sent! Thank you. I'll respond as soon as I can.";
      successEl.classList.add("is-visible");
    }
    if (btn) {
      btn.setAttribute("disabled", "disabled");
      btn.textContent = "Sent ✓";
    }
  }

  function showFailure(msg) {
    if (successEl) {
      successEl.textContent = "";
      successEl.classList.remove("is-visible");
    }
    if (failureEl) {
      // Allow <a> in error if needed, so use innerHTML only for our own strings
      failureEl.textContent = msg;
      failureEl.classList.add("is-visible");
    }
  }

  function clearMessages() {
    if (successEl) {
      successEl.textContent = "";
      successEl.classList.remove("is-visible");
    }
    if (failureEl) {
      failureEl.textContent = "";
      failureEl.classList.remove("is-visible");
    }
  }

  // Turnstile tokens are single-use, so request a fresh one after every attempt
  function resetTurnstile() {
    if (window.turnstile && typeof window.turnstile.reset === "function") {
      window.turnstile.reset();
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearMessages();

    const formData = new FormData(form);

    const turnstileToken = String(formData.get("cf-turnstile-response") || "").trim();
    if (!turnstileToken) {
      showFailure("Please complete the verification challenge before sending.");
      return;
    }

    const payload = {
      name: String(formData.get("name") || "").trim(),
      info: String(formData.get("info") || "").trim(),
      message: String(formData.get("message") || "").trim(),
      turnstileToken,
    };

    // Minimal client-side validation (mirrors server)
    if (!payload.name || payload.name.length < 2) {
      showFailure("Please enter your name (at least 2 characters).");
      return;
    }
    if (!payload.info || payload.info.length < 3) {
      showFailure("Please enter your email or phone number.");
      return;
    }

    const originalText = btn ? btn.textContent : "";
    if (btn) {
      btn.setAttribute("disabled", "disabled");
      btn.textContent = "Sending…";
    }

    try {
      const res = await fetch(form.getAttribute("action") || "/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));

      // The token has been consumed by the server side verification attempt
      resetTurnstile();

      if (res.ok && data.success) {
        showSuccess(data.message);
        form.reset();
        return;
      }

      // Validation errors from server
      if (data.fields) {
        const firstField = Object.keys(data.fields)[0];
        showFailure(data.fields[firstField]);
        if (btn) {
          btn.removeAttribute("disabled");
          btn.textContent = originalText;
        }
        return;
      }

      showFailure(
        data.error || `Something went wrong (HTTP ${res.status}). Please try again or email me directly.`
      );
      if (btn) {
        btn.removeAttribute("disabled");
        btn.textContent = originalText;
      }
    } catch (err) {
      resetTurnstile();
      showFailure("Network error – please check your connection and try again.");
      if (btn) {
        btn.removeAttribute("disabled");
        btn.textContent = originalText;
      }
    }
  });
})();
