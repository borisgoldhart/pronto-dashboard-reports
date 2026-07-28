/* ============================================================
   Pronto Base — v1 — loader
   The only tag a page needs:

     <script src="https://<host>/base/v1/loader.js"
             data-page-title="Ops Dashboard - Lewis"
             data-subtitle="Dashboard"
             data-active="home"></script>

   It injects pronto-base.css, registers <pronto-nav> and
   <pronto-banner>, and auto-mounts them at the top of <body>.
   Richer config: set window.ProntoPage = {...} BEFORE this tag
   (see README). Opt out of auto-mount with data-auto="off",
   or of the banner with data-banner="off".
   ============================================================ */
(function () {
  "use strict";
  var script = document.currentScript;
  if (!script || window.ProntoBase) return;

  var base = script.src.replace(/\/loader\.js([?#].*)?$/, "");
  var d = script.dataset || {};

  /* data-attributes fill any gaps in window.ProntoPage */
  var cfg = (window.ProntoPage = window.ProntoPage || {});
  if (cfg.pageTitle == null && d.pageTitle) cfg.pageTitle = d.pageTitle;
  if (cfg.subtitle == null && d.subtitle) cfg.subtitle = d.subtitle;
  if (cfg.active == null && d.active) cfg.active = d.active;
  if (cfg.appRoot == null && d.appRoot) cfg.appRoot = d.appRoot;
  if (cfg.user == null && d.userName) cfg.user = { name: d.userName };

  var autoMount = d.auto !== "off" && cfg.autoMount !== false;
  var wantBanner = d.banner !== "off" && cfg.banner !== false;

  /* 1) fonts — live Pronto uses Lato; opt out with data-fonts="off" */
  if (d.fonts !== "off" && !document.querySelector('link[data-pronto-fonts]')) {
    var f = document.createElement("link");
    f.rel = "stylesheet";
    f.href = "https://fonts.googleapis.com/css2?family=Lato:ital,wght@0,400;0,700;1,400&display=swap";
    f.setAttribute("data-pronto-fonts", "v1");
    document.head.appendChild(f);
  }

  /* 2) page CSS (skip if the page already loads it) */
  if (!document.querySelector("link[data-pronto-base]")) {
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = base + "/pronto-base.css";
    link.setAttribute("data-pronto-base", "v1");
    document.head.appendChild(link);
  }

  /* 3) components, then 4) auto-mount */
  function mount() {
    if (!autoMount) return;
    var body = document.body;
    if (!document.querySelector("pronto-nav")) {
      body.insertBefore(document.createElement("pronto-nav"), body.firstChild);
    }
    if (wantBanner && (cfg.pageTitle || d.pageTitle) && !document.querySelector("pronto-banner")) {
      var nav = document.querySelector("pronto-nav");
      nav.parentNode.insertBefore(document.createElement("pronto-banner"), nav.nextSibling);
    }
  }
  function onReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else fn();
  }

  var js = document.createElement("script");
  js.src = base + "/pronto-nav.js";
  js.onload = function () { onReady(mount); };
  document.head.appendChild(js);

  /* public handle */
  window.ProntoBase = {
    version: "1.0.0",
    channel: "v1",
    base: base,
    mount: function () { onReady(mount); },
    refresh: function () {
      ["pronto-nav", "pronto-banner"].forEach(function (t) {
        var el = document.querySelector(t);
        if (el && el.refresh) el.refresh();
      });
    }
  };
})();
