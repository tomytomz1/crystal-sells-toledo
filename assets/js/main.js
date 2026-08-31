/* =============================================================
   Crystal Sells Toledo — site behaviour
   No dependencies. Progressive enhancement only: every page is
   readable and every form is submittable without this file.
   ============================================================= */
(function () {
  "use strict";

  /* ---------------------------------------------------------------
     1. Site configuration
     ---------------------------------------------------------------
     SET `formEndpoint` ONCE and every form on the site starts
     delivering leads. Until then, forms fall back to opening the
     visitor's email client so nothing is ever silently lost.

     Recommended: create a free form at https://formspree.io and
     paste the endpoint below, e.g.
        formEndpoint: "https://formspree.io/f/xxxxxxxx"
     --------------------------------------------------------------- */
  var CONFIG = {
    formEndpoint: null,
    email: "crystal@crystalsellstoledo.com",
    phone: "+14195550100"
  };
  window.CRYSTAL_CONFIG = CONFIG;

  var prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
       lead-generating page is far worse than a skipped animation. Sweep
       on scroll for anything already on screen, and reveal whatever is
       left after a few seconds regardless. */
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

  /* -------------------------------------------------------- forms ----- */
  function setStatus(el, kind, html) {
    if (!el) return;
    el.className = "form-status form-status--" + kind + " is-visible";
    el.innerHTML = html;
    el.setAttribute("role", "status");
  }

  function mailtoFallback(form, data) {
    var subject = form.dataset.subject || "Website inquiry — Crystal Sells Toledo";
    var lines = [];
    Object.keys(data).forEach(function (k) {
      if (k === "_gotcha" || !data[k]) return;
      lines.push(k.replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }) + ": " + data[k]);
    });
    return "mailto:" + CONFIG.email +
      "?subject=" + encodeURIComponent(subject) +
      "&body=" + encodeURIComponent(lines.join("\n"));
  }

  function initForms() {
    document.querySelectorAll("form[data-form]").forEach(function (form) {
      var status = form.querySelector(".form-status");
      var submit = form.querySelector("[type=submit]");

      form.addEventListener("submit", function (e) {
        e.preventDefault();

        if (!form.reportValidity()) return;

        var fd = new FormData(form);
        var data = {};
        fd.forEach(function (v, k) { data[k] = typeof v === "string" ? v.trim() : v; });

        /* Honeypot: silently accept and discard obvious bots. */
        if (data._gotcha) {
          setStatus(status, "ok", "Thank you — your message is on its way.");
          form.reset();
          return;
        }

        delete data._gotcha;
        data.page = window.location.pathname;
        data.submitted_at = new Date().toISOString();

        /* No endpoint configured yet → hand off to the visitor's
           email client so a real lead is never dropped on the floor. */
        if (!CONFIG.formEndpoint) {
          var href = mailtoFallback(form, data);
          setStatus(status, "warn",
            "Almost there — your email app is opening with these details ready to send. " +
            "If nothing happens, email <a href=\"mailto:" + CONFIG.email + "\">" + CONFIG.email +
            "</a> or call <a href=\"tel:" + CONFIG.phone + "\">" + formatPhone(CONFIG.phone) + "</a>.");
          window.location.href = href;
          return;
        }

        var original = submit ? submit.textContent : "";
        if (submit) { submit.disabled = true; submit.textContent = "Sending…"; }

        fetch(CONFIG.formEndpoint, {
          method: "POST",
          headers: { "Accept": "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(data)
        }).then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          setStatus(status, "ok",
            "<strong>Thank you.</strong> Your request is in — Crystal personally replies to every inquiry, " +
            "usually within a few hours.");
          form.reset();
        }).catch(function () {
          setStatus(status, "err",
            "Something went wrong sending that. Please email <a href=\"mailto:" + CONFIG.email + "\">" +
            CONFIG.email + "</a> or call <a href=\"tel:" + CONFIG.phone + "\">" +
            formatPhone(CONFIG.phone) + "</a> and it will be handled right away.");
        }).finally(function () {
          if (submit) { submit.disabled = false; submit.textContent = original; }
        });
      });
    });
  }

  function formatPhone(e164) {
    var d = String(e164).replace(/\D/g, "").slice(-10);
    return d.length === 10 ? "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6) : e164;
  }

  /* ------------------------------------------------- current year ----- */
  function initYear() {
    document.querySelectorAll("[data-year]").forEach(function (el) {
      el.textContent = String(new Date().getFullYear());
    });
  }

  /* ------------------------------------------- image placeholders ----- */
  /* Real photography is dropped into /assets/img with the filenames
     referenced in the markup. Until then we fall back to the branded
     SVG placeholder named in data-fallback, so the site never shows
     a broken image. */
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
    initImageFallbacks();
    initHeader();
    initReveal();
    initStickyCta();
    initFaq();
    initForms();
    initYear();
  });
})();
