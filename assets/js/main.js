/* =============================================================
   Crystal Sells Toledo - site behaviour
   No dependencies. Progressive enhancement: every page is readable
   and every form reachable without this file.
   ============================================================= */
(function () {
  "use strict";

  /* ---------------------------------------------------------------
     1. Site configuration
     ---------------------------------------------------------------
     Leads POST to a same-origin serverless endpoint. Nothing secret
     lives here - the browser never sees CRM credentials.

     `mailtoFallbackEnabled` keeps the old email-client hand-off alive
     as an EMERGENCY recovery path only. It is offered as a link the
     visitor can choose after a failure; it is never opened for them
     and it is not the normal submission route.
     --------------------------------------------------------------- */
  var CONFIG = {
    leadEndpoint: "/api/lead",
    email: "crystal@crystalsellstoledo.com",
    phone: "+14192454655",
    mailtoFallbackEnabled: true
  };
  window.CRYSTAL_CONFIG = CONFIG;

  var prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function formatPhone(e164) {
    var d = String(e164).replace(/\D/g, "").slice(-10);
    return d.length === 10 ? "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6) : e164;
  }

  /* =============================================================
     2. Attribution - first touch, preserved
     =============================================================
     The acquisition source is recorded on the FIRST visit and never
     overwritten. A visitor who arrives from an ad, leaves, and returns
     directly a week later is still credited to the ad.
     ============================================================= */
  var ATTR_KEY = "csv_attr_v1";
  var ATTR_PARAMS = [
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "gclid", "gbraid", "wbraid", "fbclid", "msclkid"
  ];

  var attribution = (function () {
    function captureCurrent() {
      var params;
      try { params = new URLSearchParams(window.location.search); }
      catch (e) { params = null; }

      var out = {};
      ATTR_PARAMS.forEach(function (k) {
        out[k] = params ? (params.get(k) || "") : "";
      });
      out.landing_page = window.location.pathname + window.location.search;
      out.referrer = document.referrer || "";
      out.first_touch_at = new Date().toISOString();
      return out;
    }

    function read() {
      try {
        var stored = JSON.parse(window.localStorage.getItem(ATTR_KEY) || "null");
        if (stored && stored.first_touch_at) return stored;
      } catch (e) { /* private mode, blocked storage, corrupt value */ }
      return null;
    }

    function ensure() {
      var existing = read();
      if (existing) return existing;
      var fresh = captureCurrent();
      try { window.localStorage.setItem(ATTR_KEY, JSON.stringify(fresh)); }
      catch (e) { /* nothing persisted; this visit still reports correctly */ }
      return fresh;
    }

    return { ensure: ensure, read: read, captureCurrent: captureCurrent };
  })();

  /* =============================================================
     3. Analytics abstraction
     =============================================================
     Dispatches a browser CustomEvent for every tracked action, so the
     site is instrumented before any analytics vendor is installed.
     GA4 / GTM are forwarded to only if they happen to be present.
     ============================================================= */
  var analytics = (function () {
    function base(extra) {
      var a = attribution.read() || {};
      var payload = {
        page: window.location.pathname,
        utm_source: a.utm_source || "",
        utm_medium: a.utm_medium || "",
        utm_campaign: a.utm_campaign || ""
      };
      if (extra) Object.keys(extra).forEach(function (k) { payload[k] = extra[k]; });
      return payload;
    }

    function track(name, extra) {
      var detail = base(extra);
      try {
        window.dispatchEvent(new CustomEvent(name, { detail: detail }));
      } catch (e) { /* very old browser; tracking is never load-bearing */ }
      if (Array.isArray(window.dataLayer)) {
        window.dataLayer.push(Object.assign({ event: name }, detail));
      }
      if (typeof window.gtag === "function") window.gtag("event", name, detail);
      return detail;
    }

    return { track: track };
  })();
  window.CRYSTAL_ANALYTICS = analytics;

  /* ------------------------------------------------------- header ---- */
  function initHeader() {
    var header = document.querySelector(".site-header");
    if (!header) return;

    var toggle = header.querySelector(".nav-toggle");
    var nav = header.querySelector(".nav");
    var solidAt = 40;
    var ticking = false;

    function onScroll() {
      header.classList.toggle("is-solid", window.scrollY > solidAt);
      ticking = false;
    }
    window.addEventListener("scroll", function () {
      if (!ticking) { ticking = true; window.requestAnimationFrame(onScroll); }
    }, { passive: true });
    onScroll();

    if (!toggle || !nav) return;

    function setOpen(open) {
      header.classList.toggle("is-open", open);
      toggle.setAttribute("aria-expanded", String(open));
      document.body.style.overflow = open && window.innerWidth <= 940 ? "hidden" : "";
    }
    toggle.addEventListener("click", function () {
      setOpen(toggle.getAttribute("aria-expanded") !== "true");
    });
    nav.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && header.classList.contains("is-open")) {
        setOpen(false); toggle.focus();
      }
    });
    window.addEventListener("resize", function () {
      if (window.innerWidth > 940) setOpen(false);
    });
  }

  /* ------------------------------------------------- scroll reveal ---- */
  function initReveal() {
    var pending = Array.prototype.slice.call(document.querySelectorAll(".reveal"));
    if (!pending.length) return;

    function show(el) {
      el.classList.add("is-in");
      var i = pending.indexOf(el);
      if (i > -1) pending.splice(i, 1);
    }
    function showAll() { pending.slice().forEach(show); }

    if (prefersReduced || !("IntersectionObserver" in window)) { showAll(); return; }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { show(entry.target); io.unobserve(entry.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    pending.forEach(function (el) { io.observe(el); });

    /* Safety net. An observer callback can be missed during very fast or
       programmatic scrolling, and a permanently invisible section on a
       lead-generating page is far worse than a skipped animation. */
    var sweeping = false;
    function sweep() {
      sweeping = false;
      if (!pending.length) { window.removeEventListener("scroll", onScroll); return; }
      var vh = window.innerHeight || document.documentElement.clientHeight;
      pending.slice().forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (r.top < vh * 0.94 && r.bottom > 0) { show(el); io.unobserve(el); }
      });
    }
    function onScroll() {
      if (!sweeping) { sweeping = true; window.requestAnimationFrame(sweep); }
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    setTimeout(showAll, 6000);
  }

  /* -------------------------------------------------- sticky CTA ------ */
  function initStickyCta() {
    var bar = document.querySelector(".sticky-cta");
    if (!bar) return;
    var ticking = false;
    function check() {
      bar.classList.toggle("is-visible", window.scrollY > 520);
      ticking = false;
    }
    window.addEventListener("scroll", function () {
      if (!ticking) { ticking = true; window.requestAnimationFrame(check); }
    }, { passive: true });
    check();
  }

  /* --------------------------------------------------------- FAQ ------ */
  function initFaq() {
    document.querySelectorAll(".faq__q").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var open = btn.getAttribute("aria-expanded") === "true";
        var panel = document.getElementById(btn.getAttribute("aria-controls"));
        btn.setAttribute("aria-expanded", String(!open));
        if (panel) panel.classList.toggle("is-open", !open);
      });
    });
  }

  /* =============================================================
     4. Forms
     ============================================================= */
  function setStatus(el, kind, html) {
    if (!el) return;
    el.className = "form-status form-status--" + kind + " is-visible";
    el.innerHTML = html;
    el.setAttribute("role", "status");
  }

  function contactLine() {
    return "call <a href=\"tel:" + CONFIG.phone + "\">" + formatPhone(CONFIG.phone) +
      "</a> or email <a href=\"mailto:" + CONFIG.email + "\">" + CONFIG.email + "</a>";
  }

  function mailtoHref(form, data) {
    var subject = form.dataset.subject || "Website inquiry - Crystal Sells Toledo";
    var lines = [];
    Object.keys(data).forEach(function (k) {
      if (k === "_gotcha" || k === "attribution" || !data[k]) return;
      lines.push(k.replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }) +
        ": " + data[k]);
    });
    return "mailto:" + CONFIG.email +
      "?subject=" + encodeURIComponent(subject) +
      "&body=" + encodeURIComponent(lines.join("\n"));
  }

  function serialize(form) {
    var fd = new FormData(form);
    var data = {};
    fd.forEach(function (v, k) { data[k] = typeof v === "string" ? v.trim() : v; });
    return data;
  }

  function initForms() {
    document.querySelectorAll("form[data-form]").forEach(function (form) {
      var status = form.querySelector(".form-status");
      var submit = form.querySelector("[type=submit]");
      var formType = form.dataset.formType || "contact";
      var startedTracked = false;

      form.addEventListener("input", function () {
        if (startedTracked) return;
        startedTracked = true;
        analytics.track("lead_form_start", { form_type: formType });
      }, { once: false });

      form.addEventListener("submit", function (e) {
        e.preventDefault();
        if (!form.reportValidity()) return;

        var data = serialize(form);
        var honeypot = data._gotcha;
        delete data._gotcha;

        var payload = {
          form_type: formType,
          first_name: data.first_name || "",
          last_name: data.last_name || "",
          email: data.email || "",
          phone: data.phone || "",
          property_address: data.property_address || "",
          topic: data.topic || "",
          message: data.message || "",
          timeline: data.timeline || "",
          condition: data.condition || "",
          notes: data.notes || "",
          page: window.location.pathname,
          attribution: attribution.ensure(),
          _gotcha: honeypot || ""
        };

        var original = submit ? submit.textContent : "";
        if (submit) { submit.disabled = true; submit.textContent = "Sending..."; }
        setStatus(status, "warn", "Sending your request...");

        fetch(CONFIG.leadEndpoint, {
          method: "POST",
          headers: { "Accept": "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }).then(function (res) {
          return res.json().catch(function () { return { ok: false, code: "BAD_RESPONSE" }; })
            .then(function (json) { return { res: res, json: json }; });
        }).then(function (r) {
          /* Success is asserted ONLY when the server says so. A 2xx with
             ok:false, or any non-2xx, is a failure and is treated as one. */
          if (!r.res.ok || !r.json || r.json.ok !== true) {
            var code = (r.json && r.json.code) || ("HTTP_" + r.res.status);
            var msg = (r.json && r.json.message) || null;
            throw Object.assign(new Error(code), { code: code, userMessage: msg });
          }

          setStatus(status, "ok",
            "<strong>Thank you.</strong> Your request is in - Crystal personally replies to every " +
            "inquiry, usually within a few hours.");
          analytics.track("lead_submit_success", {
            form_type: formType,
            submission_id: r.json.submission_id
          });
          /* Reset only after the server accepted it. */
          form.reset();
          form.dataset.submissionId = r.json.submission_id || "";
          if (form.dataset.steps) resetSteps(form);
        }).catch(function (err) {
          /* Everything the visitor typed is still in the form. */
          var extra = "";
          if (CONFIG.mailtoFallbackEnabled) {
            extra = " If you would rather send it by email instead, " +
              "<a href=\"" + mailtoHref(form, data) + "\">open a pre-filled message</a>.";
          }
          setStatus(status, "err",
            (err && err.userMessage
              ? err.userMessage
              : "We could not submit that just now. Nothing you typed has been lost.") +
            " Please " + contactLine() + "." + extra);
          analytics.track("lead_submit_error", {
            form_type: formType,
            error_code: (err && err.code) || "UNKNOWN"
          });
        }).finally(function () {
          if (submit) { submit.disabled = false; submit.textContent = original; }
        });
      });
    });
  }

  /* =============================================================
     5. Progressive (multi-step) forms
     =============================================================
     Steps are shown and hidden with the `hidden` attribute rather than
     CSS alone, so an inactive step is removed from the accessibility
     tree and from the tab order instead of being merely invisible.
     Without JS every step renders, so the form still works.
     ============================================================= */
  function stepsOf(form) {
    return Array.prototype.slice.call(form.querySelectorAll("[data-step]"));
  }

  function showStep(form, index) {
    var steps = stepsOf(form);
    steps.forEach(function (s, i) { s.hidden = i !== index; });
    form.dataset.currentStep = String(index);

    var indicator = form.querySelector("[data-step-indicator]");
    if (indicator) indicator.textContent = "Step " + (index + 1) + " of " + steps.length;

    /* Move focus to the new step so keyboard and screen-reader users are
       taken to the content that just appeared. */
    var target = steps[index];
    if (target) {
      var first = target.querySelector("input, select, textarea, button");
      if (first && index > 0) first.focus();
    }
  }

  function resetSteps(form) { showStep(form, 0); }

  function initSteps() {
    document.querySelectorAll("form[data-steps]").forEach(function (form) {
      var steps = stepsOf(form);
      if (steps.length < 2) return;
      var formType = form.dataset.formType || "contact";

      showStep(form, 0);

      form.querySelectorAll("[data-step-next]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var current = Number(form.dataset.currentStep || 0);
          var fields = steps[current].querySelectorAll("input, select, textarea");
          for (var i = 0; i < fields.length; i++) {
            if (!fields[i].checkValidity()) { fields[i].reportValidity(); return; }
          }
          analytics.track("lead_form_step_complete", {
            form_type: formType,
            step: current + 1
          });
          showStep(form, Math.min(current + 1, steps.length - 1));
        });
      });

      form.querySelectorAll("[data-step-back]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          showStep(form, Math.max(Number(form.dataset.currentStep || 0) - 1, 0));
        });
      });
    });
  }

  /* =============================================================
     6. CTA and contact-intent tracking
     ============================================================= */
  function initCtaTracking() {
    document.addEventListener("click", function (e) {
      var link = e.target.closest("a");
      if (!link) return;
      var href = link.getAttribute("href") || "";

      if (href.indexOf("tel:") === 0) {
        analytics.track("phone_click", { destination: href });
      } else if (href.indexOf("mailto:") === 0) {
        analytics.track("email_click", { destination: href });
      } else if (href === "/home-value" || href.indexOf("/home-value") === 0) {
        analytics.track("cta_home_value_click", { link_text: (link.textContent || "").trim().slice(0, 60) });
      } else if (href === "/sell" || href.indexOf("/sell") === 0) {
        analytics.track("cta_sell_click", { link_text: (link.textContent || "").trim().slice(0, 60) });
      }
    }, { passive: true });
  }

  /* ------------------------------------------------- current year ----- */
  function initYear() {
    document.querySelectorAll("[data-year]").forEach(function (el) {
      el.textContent = String(new Date().getFullYear());
    });
  }

  /* ------------------------------------------- image placeholders ----- */
  function initImageFallbacks() {
    document.querySelectorAll("img[data-fallback]").forEach(function (img) {
      function swap() {
        if (img.dataset.swapped) return;
        img.dataset.swapped = "1";
        img.src = img.dataset.fallback;
      }
      img.addEventListener("error", swap);
      if (img.complete && img.naturalWidth === 0) swap();
    });
  }

  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  ready(function () {
    attribution.ensure();
    initImageFallbacks();
    initHeader();
    initReveal();
    initStickyCta();
    initFaq();
    initSteps();
    initForms();
    initCtaTracking();
    initYear();
  });
})();
