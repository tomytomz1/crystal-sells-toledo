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

    /* A fixed bar asking for the form, sitting on top of the form, is a
       tax on the visitor who already scrolled to it. Track whether any
       lead form is on screen and stand down while one is. Native
       IntersectionObserver only, and where it is missing the bar simply
       keeps the old scroll-distance behaviour. */
    var formOnScreen = false;
    /* Also stand down around a visible inline CTA. A fixed bar offering the
       same action as a button the visitor can already see is just noise. */
    var regions = document.querySelectorAll(
      "[data-form-region], .cuepoint, .cta-band [data-review-cta]");
    if (regions.length && "IntersectionObserver" in window) {
      var seen = new WeakSet();
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) seen.add(e.target); else seen.delete(e.target);
        });
        formOnScreen = Array.prototype.some.call(regions, function (r) { return seen.has(r); });
        check();
      }, { rootMargin: "-15% 0px -15% 0px" });
      Array.prototype.forEach.call(regions, function (r) { io.observe(r); });
    }

    var ticking = false;
    function check() {
      bar.classList.toggle("is-visible", window.scrollY > 520 && !formOnScreen);
      ticking = false;
    }
    window.addEventListener("scroll", function () {
      if (!ticking) { ticking = true; window.requestAnimationFrame(check); }
    }, { passive: true });
    check();
  }

  /* ------------------------------------------- in-page CTA to the form -
     Several places on /43551-seller-review invite the visitor back to the
     one form at the top. The href does the scrolling, so this works with
     no JavaScript at all; all that is added here is moving focus to the
     address field once the browser has arrived, with preventScroll so the
     focus cannot fight the scroll that is still animating. */
  function initFormCtas() {
    document.addEventListener("click", function (e) {
      var link = e.target.closest("a[data-review-cta]");
      if (!link) return;
      var href = link.getAttribute("href") || "";
      if (href.charAt(0) !== "#") return;
      var target = document.getElementById(href.slice(1));
      if (!target) return;
      /* The first input inside the form region is the honeypot, which is
         hidden and tabindex="-1". Prefer the address field by name. */
      var field = target.querySelector('input[name="property_address"]')
        || target.querySelector('input:not(.hp):not([tabindex="-1"]), select, textarea');
      if (!field) return;
      var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.setTimeout(function () {
        try { field.focus({ preventScroll: true }); } catch (err) { field.focus(); }
      }, reduced ? 0 : 450);
    });
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

          analytics.track("lead_submit_success", {
            form_type: formType,
            submission_id: r.json.submission_id
          });
          /* Kept for support, never rendered. */
          form.dataset.submissionId = r.json.submission_id || "";

          if (!revealSuccess(form)) {
            /* No success panel in this form's region (the contact page).
               Fall back to the inline confirmation, which is safe there
               because that form is a single step and nothing collapses. */
            setStatus(status, "ok",
              "<strong>Thank you.</strong> Your request is in - Crystal personally replies to " +
              "every inquiry, usually within a few hours.");
            form.reset();
            if (form.dataset.steps) resetSteps(form);
          }
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
  /**
   * Swap the submitted form for its success panel, in place.
   *
   * The form is HIDDEN, not reset: a reset would collapse step 2 back to
   * step 1, shrink the document, and let the browser clamp the scroll
   * position - which is what previously dumped the visitor mid-page with no
   * confirmation in sight, since .form-status lives inside step 2.
   *
   * Returns false when this form has no panel, so the caller can fall back.
   */
  function revealSuccess(form) {
    var region = form.closest("[data-form-region]");
    var panel = region ? region.querySelector("[data-form-success]") : null;
    if (!panel) return false;

    var before = form.getBoundingClientRect().top;
    form.hidden = true;
    panel.hidden = false;

    /* Read AFTER the swap so the delta reflects real, settled layout. */
    var after = panel.getBoundingClientRect().top;
    var drift = after - before;
    if (drift) window.scrollBy(0, drift);

    var heading = panel.querySelector("[data-success-heading]");
    if (heading) {
      /* preventScroll: focusing must not undo the anchoring just applied. */
      heading.focus({ preventScroll: true });
      /* A visitor submits from the BOTTOM of a tall step 2, so the panel that
         replaces it usually lands above the viewport. Anchoring alone would
         leave them staring at whatever now occupies that space. Bring the
         confirmation into view whenever it is not already fully visible -
         this is the last thing that runs, so nothing undoes it. */
      var box = panel.getBoundingClientRect();
      var vh = window.innerHeight || document.documentElement.clientHeight;
      if (box.top < 0 || box.bottom > vh) panel.scrollIntoView({ block: "center" });
    }
    return true;
  }

  function stepsOf(form) {
    return Array.prototype.slice.call(form.querySelectorAll("[data-step]"));
  }

  /**
   * Bring a step that has just reappeared under the fixed header, then put
   * the caret in it.
   *
   * Measured AFTER the swap, so the numbers describe settled layout. The
   * scroll runs first and the focus uses preventScroll, so focusing cannot
   * undo the scroll - and neither happens at all when the step is already
   * sitting clear of the header and inside the viewport, which is the common
   * case on a page where the form starts near the top.
   *
   * The header offset is not computed here: `html { scroll-padding-top }`
   * already declares it for the whole site and scrollIntoView honours it, so
   * one number governs anchors, skip links and this. Behaviour is left as
   * `auto` so the CSS `scroll-behavior` - and its reduced-motion override -
   * decides whether the move animates.
   */
  function revealStep(step, field) {
    var header = document.querySelector(".site-header");
    var headerBottom = header ? header.getBoundingClientRect().bottom : 0;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var box = step.getBoundingClientRect();
    if (box.top < headerBottom || box.bottom > vh) step.scrollIntoView({ block: "start" });
    if (field) field.focus({ preventScroll: true });
  }

  /**
   * `opts.reveal` is set only by "Back to address".
   *
   * Going back from the bottom of a tall step 2 collapses the document, and
   * the browser clamps the scroll position - leaving the visitor looking at
   * whatever now occupies that space, with the restored address field
   * off-screen above them and focus dropped on <body>. Forward moves and the
   * page-load call keep the behaviour they had: forward already lands on the
   * fields that just appeared, and taking focus on load would scroll the
   * page for every visitor.
   */
  function showStep(form, index, opts) {
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
      if (opts && opts.reveal) revealStep(target, first);
      else if (first && index > 0) first.focus();
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
          showStep(form, Math.max(Number(form.dataset.currentStep || 0) - 1, 0), { reveal: true });
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

      if (link.dataset.reviewCta) {
        analytics.track("cta_review_click", {
          position: link.dataset.reviewCta,
          link_text: (link.textContent || "").trim().slice(0, 60)
        });
      }

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

  /* =============================================================
     7. Google Places address autocomplete
     =============================================================
     Progressive enhancement over the ordinary address input.

     The input stays the single source of truth. Google never replaces
     it, never owns it, and never gates it: a visitor can ignore every
     suggestion, type a rural route or a brand-new build Google has never
     heard of, and submit exactly as before. An address Google cannot find
     is still a lead.

     This uses the Place Autocomplete DATA api and renders the list
     ourselves rather than the PlaceAutocompleteElement widget, because
     the widget brings its own shadow-DOM input - which would displace the
     real `property_address` field, its label, its maxlength and its
     required state, and cannot be styled to match the dark hero.

     Anything that goes wrong - no key, script blocked, offline, API error,
     quota exhausted - closes the list and leaves a plain text field.
     ============================================================= */
  var ADDRESS_DEBOUNCE_MS = 250;
  var ADDRESS_MAX_SUGGESTIONS = 5;

  /* Bias toward Perrysburg without RESTRICTING to it. Crystal works the
     wider Toledo metro and must not appear to refuse other areas - and a
     restriction would silently drop a legitimate address just outside it. */
  var ADDRESS_BIAS = { center: { lat: 41.557, lng: -83.627 }, radius: 50000 };

  /* Homes resolve as street_address or premise. `subpremise` is deliberately
     absent: Places Autocomplete does not support it, and including it makes
     Google reject the WHOLE request - which is exactly how the bias got lost
     and national landmarks outranked local streets. Max five values. */
  var ADDRESS_TYPES = ["street_address", "premise"];

  /* Console-only, once per page. A visitor must never see this; a developer
     looking at why suggestions are odd absolutely must. */
  var warned = {};
  function warnOnce(what, err) {
    if (warned[what] || !window.console || !console.warn) return;
    warned[what] = true;
    console.warn("[crystal] " + what + (err && err.message ? ": " + err.message : ""));
  }

  function initAddressAutocomplete() {
    var inputs = document.querySelectorAll('input[name="property_address"]');
    if (!inputs.length) return;

    /* Absent unless the build injected a Maps key. */
    if (!window.__csvMapsReady || typeof window.__csvMapsReady.then !== "function") return;

    window.__csvMapsReady.then(function () {
      if (!window.google || !google.maps || !google.maps.importLibrary) return;
      return google.maps.importLibrary("places").then(function (places) {
        Array.prototype.forEach.call(inputs, function (input) {
          attachAddressAutocomplete(input, places);
        });
      });
    }).catch(function () {
      /* Stay a plain text field. Never surface this to the visitor: the
         form works, and an error about a mapping service would only make
         them think their enquiry failed. */
    });
  }

  function attachAddressAutocomplete(input, places) {
    var Suggestion = places.AutocompleteSuggestion;
    var SessionToken = places.AutocompleteSessionToken;
    if (!Suggestion || !SessionToken) return;

    var field = input.parentNode;
    var list = document.createElement("ul");
    var listId = (input.id || "addr") + "-suggestions";
    list.id = listId;
    list.className = "addr-suggest";
    list.setAttribute("role", "listbox");
    list.hidden = true;
    field.appendChild(list);

    var live = document.createElement("p");
    live.className = "sr-only";
    live.setAttribute("aria-live", "polite");
    field.appendChild(live);

    /* The browser's own street-address autofill would draw a second,
       competing dropdown over ours. The attribute stays in the markup so
       the no-JS path keeps it; it is only dropped once ours is live. */
    input.setAttribute("autocomplete", "off");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", listId);
    input.setAttribute("aria-autocomplete", "list");

    var token = new SessionToken();
    /* The exact value this widget last wrote into the input. While the input
       still holds it, the visitor has chosen and not yet edited, so there is
       nothing to look up. Cleared the moment they change a character. */
    var chosenValue = null;
    /* True only while WE are dispatching input/change after a selection, so
       our own listener can tell our write apart from the visitor typing. */
    var programmatic = false;
    var items = [];
    var active = -1;
    var timer = null;
    var seq = 0;
    var disabled = false;

    function close() {
      list.hidden = true;
      list.innerHTML = "";
      items = [];
      active = -1;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }

    function setActive(i) {
      var opts = list.querySelectorAll("[role=option]");
      if (!opts.length) return;
      if (active >= 0 && opts[active]) opts[active].setAttribute("aria-selected", "false");
      active = (i + opts.length) % opts.length;
      opts[active].setAttribute("aria-selected", "true");
      input.setAttribute("aria-activedescendant", opts[active].id);
      if (opts[active].scrollIntoView) opts[active].scrollIntoView({ block: "nearest" });
    }

    /**
     * Choosing a suggestion is TERMINAL for that interaction.
     *
     * It previously was not. Writing the address dispatched an `input` event
     * so the rest of the form would notice, that event synchronously re-entered
     * our own input listener, which scheduled another lookup, and the menu
     * reopened underneath the address the visitor had just picked. A response
     * already in flight could do the same thing on its own.
     *
     * So all four routes are closed here: the pending debounce is cancelled,
     * the request sequence is invalidated so a late response cannot render,
     * our own listener is told to ignore the write we are about to announce,
     * and the chosen value is remembered so nothing reopens while it stands.
     */
    function choose(i) {
      if (!items[i]) return;
      var value = items[i];

      clearTimeout(timer);
      /* Any response still in flight belongs to a query the visitor has now
         answered. Bumping the sequence makes it land on the floor. */
      seq++;

      /* Never write more than the server will accept. */
      input.value = value.slice(0, Number(input.getAttribute("maxlength")) || 200);
      chosenValue = input.value;
      close();

      /* A new session begins after a selection - this is what keeps
         autocomplete billed per session rather than per keystroke. */
      token = new SessionToken();

      /* The rest of the form still needs to know the field changed. Guarded so
         announcing it cannot be mistaken for the visitor typing. */
      programmatic = true;
      try {
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } finally {
        programmatic = false;
      }

      analytics.track("address_suggestion_selected", { page: location.pathname });
      /* Focus stays in the field - the visitor may want to edit what they
         picked. Blurring to hide the menu would be a worse fix than none. */
      input.focus();
    }

    function render(values) {
      items = values;
      list.innerHTML = "";
      if (!values.length) { close(); return; }
      values.forEach(function (text, i) {
        var li = document.createElement("li");
        li.id = listId + "-" + i;
        li.className = "addr-suggest__item";
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", "false");
        li.textContent = text;
        /* pointerdown, not click: click fires after blur, which would
           have already closed the list. */
        li.addEventListener("pointerdown", function (e) { e.preventDefault(); choose(i); });
        list.appendChild(li);
      });
      list.hidden = false;
      active = -1;
      input.setAttribute("aria-expanded", "true");
      live.textContent = values.length + " address suggestions available.";
    }

    function request(value, opts) {
      var req = { input: value, sessionToken: token, language: "en", region: "us" };
      /* Bias is sent on its own, never bundled with the type filter. They
         fail independently, and a rejected type filter must not silently
         cost us the bias - that is what put Detroit above Perrysburg. */
      if (opts.bias) req.locationBias = ADDRESS_BIAS;
      if (opts.types) req.includedPrimaryTypes = ADDRESS_TYPES;
      return Suggestion.fetchAutocompleteSuggestions(req);
    }

    function fetchFor(value) {
      var mine = ++seq;
      /* Degrade one parameter at a time, most useful last to go. Losing the
         type filter costs a little precision; losing the bias makes the
         feature actively misleading, so it is only given up to save the
         feature entirely. */
      request(value, { bias: true, types: true })
        .catch(function (err) {
          warnOnce("address type filter rejected by Places", err);
          return request(value, { bias: true, types: false });
        })
        .catch(function (err) {
          warnOnce("address location bias rejected by Places", err);
          return request(value, { bias: false, types: false });
        })
        .then(function (res) {
          if (mine !== seq || disabled) return;          // a newer keystroke won
          var out = [];
          var suggestions = (res && res.suggestions) || [];
          for (var i = 0; i < suggestions.length && out.length < ADDRESS_MAX_SUGGESTIONS; i++) {
            var pred = suggestions[i] && suggestions[i].placePrediction;
            var text = pred && pred.text ? String(pred.text) : "";
            if (text) out.push(text);
          }
          render(out);
        })
        .catch(function () {
          /* Quota, network, revoked key. Give up quietly and for good -
             retrying on every keystroke would just burn the quota. */
          disabled = true;
          close();
        });
    }

    input.addEventListener("input", function () {
      if (disabled) return;
      /* Our own post-selection announcement, not the visitor. */
      if (programmatic) return;

      var value = input.value.trim();
      clearTimeout(timer);

      /* Still exactly what was chosen - nothing to look up, and reopening
         would put a menu over an answered field. Any real edit falls through
         and clears this, so autocomplete comes straight back. */
      if (chosenValue !== null && input.value === chosenValue) return;
      chosenValue = null;

      if (value.length < 3) { close(); return; }
      timer = setTimeout(function () { fetchFor(value); }, ADDRESS_DEBOUNCE_MS);
    });

    input.addEventListener("keydown", function (e) {
      if (list.hidden) return;
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
      else if (e.key === "Enter") {
        /* Only swallow Enter when a suggestion is actually highlighted.
           Otherwise the visitor keeps normal form behaviour. */
        if (active >= 0) { e.preventDefault(); choose(active); }
        else close();
      } else if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "Tab") { close(); }
    });

    input.addEventListener("blur", function () {
      /* Delayed so a pointerdown on an option still registers. */
      setTimeout(close, 150);
    });
  }

  /* =============================================================
     8. US phone formatting
     =============================================================
     Presentation and normalisation ONLY. api/_lib/validate.mjs stays
     authoritative: it re-normalises whatever arrives and rejects anything
     over the limit. Nothing here relaxes that.

     A visitor typing 5863241248 saw 5863241248 back, which reads as a
     number the site did not understand.
     ============================================================= */

  /** The logical value: at most ten US digits, country code dropped. */
  function phoneDigits(raw) {
    var d = String(raw == null ? "" : raw).replace(/\D/g, "");
    /* A leading 1 is the US country code only once the rest is a full
       number - stripping it earlier would eat a real area code digit. */
    if (d.length === 11 && d.charAt(0) === "1") d = d.slice(1);
    return d.slice(0, 10);
  }

  /** Progressive display: 5 / 58 / 586 / (586) 3 / (586) 324-1248 */
  function phoneFormat(d) {
    if (!d) return "";
    if (d.length <= 3) return d;
    if (d.length <= 6) return "(" + d.slice(0, 3) + ") " + d.slice(3);
    return "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6);
  }

  /** How many digits precede this caret position. Punctuation never counts. */
  function digitsBefore(text, caret) {
    var n = 0;
    for (var i = 0; i < caret && i < text.length; i++)
      if (text.charAt(i) >= "0" && text.charAt(i) <= "9") n++;
    return n;
  }

  /** Where the caret goes to sit after `n` digits of the formatted text. */
  function caretAfterDigits(text, n) {
    if (n <= 0) return 0;
    var seen = 0;
    for (var i = 0; i < text.length; i++) {
      if (text.charAt(i) >= "0" && text.charAt(i) <= "9") {
        seen++;
        if (seen === n) return i + 1;
      }
    }
    return text.length;
  }

  function initPhoneFormat() {
    document.querySelectorAll('input[name="phone"]').forEach(function (input) {
      input.setAttribute("inputmode", "tel");

      function apply(rawValue, digitPos) {
        var text = phoneFormat(phoneDigits(rawValue));
        if (input.value !== text) input.value = text;
        if (digitPos != null && document.activeElement === input) {
          var pos = caretAfterDigits(text, digitPos);
          try { input.setSelectionRange(pos, pos); } catch (err) { /* not selectable */ }
        }
      }

      /* Backspace and Delete must never strand the caret on generated
         punctuation. When the character being removed is punctuation, take
         the nearest digit on that side instead, so held-down Backspace walks
         straight out of the field instead of sticking on ") ". */
      input.addEventListener("keydown", function (e) {
        if (e.key !== "Backspace" && e.key !== "Delete") return;
        if (input.selectionStart !== input.selectionEnd) return;   // a range: let it through
        var v = input.value;
        var at = input.selectionStart;
        var isDigit = function (c) { return c >= "0" && c <= "9"; };

        if (e.key === "Backspace") {
          var i = at - 1;
          while (i >= 0 && !isDigit(v.charAt(i))) i--;
          if (i < 0) return;                       // only punctuation behind
          if (i === at - 1) return;                // already a digit: normal path
          e.preventDefault();
          apply(v.slice(0, i) + v.slice(at), digitsBefore(v, i));
        } else {
          var j = at;
          while (j < v.length && !isDigit(v.charAt(j))) j++;
          if (j >= v.length) return;
          if (j === at) return;
          e.preventDefault();
          apply(v.slice(0, j) + v.slice(j + 1), digitsBefore(v, at));
        }
      });

      /* Covers typing, paste, cut, range replacement and drag-drop: the
         browser has already applied the edit, so the caret is read from the
         raw text and re-placed after the same number of digits. */
      input.addEventListener("input", function () {
        apply(input.value, digitsBefore(input.value, input.selectionStart || 0));
      });

      /* Some browsers autofill without firing `input`. */

      input.addEventListener("change", function () { apply(input.value, null); });
      input.addEventListener("blur", function () { apply(input.value, null); });

      /* An autofilled value present before this ran. Blank stays blank. */
      if (input.value) apply(input.value, null);
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
    initFormCtas();
    initAddressAutocomplete();
    initPhoneFormat();
    initYear();
  });
})();
