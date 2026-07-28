/* ============================================================
   Pronto Base — v1 — <pronto-nav> and <pronto-banner>
   Shadow-DOM web components. Dimensions, typography and dropdown
   behaviour measured from the live havaspronto.com nav (Jul 2026):

     bar: white, 56px, fixed, padding 0 40px, logo 200x22 left,
          items centred, search/+/avatar right
     item: h36, pad 0 12, radius 4, icon 12px + gap 6,
           Lato 13px/700 #18181a, hover #f2f2f2
     menu panel: white, 1px #cac9cc, radius 4, pad 4px 0,
           shadow 0 10px 15px -3px rgba(0,0,0,.1), 0 4px 6px -4px rgba(0,0,0,.1)
           wide nav panels 528px; +/avatar panels 272px right-aligned
     menu row: h32, pad 0 12, icon 12px + gap 8, Lato 12px/700 #222,
           pitch 36 (4px gap); section head 11px/700 UPPERCASE ls 1.1 #666
     behaviour: click toggles, outside click / Escape closes,
           one menu open at a time

   Config precedence: element attributes → window.ProntoPage → defaults.
   Live-data hooks: cfg.fetchUser() and cfg.fetchMenu(id) (phase 2).
   Note: live site uses Font Awesome Pro; we ship license-free
   lookalike SVGs — override per item with iconHtml if needed.
   ============================================================ */
(function () {
  "use strict";
  if (window.customElements && customElements.get("pronto-nav")) return;

  var CFG = function () { return window.ProntoPage || {}; };

  var SCRIPT_BASE = (function () {
    var s = document.currentScript;
    if (s && s.src) return s.src.replace(/\/[^/]*$/, "");
    return (window.ProntoBase && window.ProntoBase.base) || null;
  })();

  var LOGO_REMOTE = "https://havaspronto.com/v2/build/images/logos/Havas-pronto-wide.png";
  var LOGO_TEXT = '<span class="havas">HAVAS</span><span class="pronto">Pronto</span><span class="bang">!</span>';

  /* ---------- icons (inline SVG, stroke, 24 viewBox) ---------- */
  function svg(paths, size) {
    return '<svg viewBox="0 0 24 24" width="' + (size || 13) + '" height="' + (size || 13) +
      '" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + "</svg>";
  }
  var P = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5"/>',
    inbox: '<path d="M3 13h5l1.5 2.5h5L16 13h5"/><path d="M5 4h14l2 9v7H3v-7z"/>',
    rocket: '<path d="M13.5 4.5C16 2.5 21 2.5 21 2.5s0 5-2 7.5c-2.6 3.3-6.5 6-9 7L6 13c1-2.5 4.9-6.4 7.5-8.5z"/><circle cx="15.5" cy="8.5" r="1.4"/><path d="M6.5 13 3 14l3-4M11 17.5 10 21l4-3M5.5 18.5 3 21"/>',
    star: '<path d="m12 4 2.4 5.1 5.6.6-4.2 3.8 1.2 5.5L12 16.2 7 19l1.2-5.5L4 9.7l5.6-.6z"/>',
    timesheets: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M12 11v3l2 1.2"/>',
    apps: '<circle cx="5.5" cy="5.5" r="1.4"/><circle cx="12" cy="5.5" r="1.4"/><circle cx="18.5" cy="5.5" r="1.4"/><circle cx="5.5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18.5" cy="12" r="1.4"/><circle cx="5.5" cy="18.5" r="1.4"/><circle cx="12" cy="18.5" r="1.4"/><circle cx="18.5" cy="18.5" r="1.4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    chevron: '<path d="m6 9.5 6 6 6-6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 10.8V17"/><path d="M12 7.5v.2"/>',
    user: '<circle cx="12" cy="8.2" r="3.7"/><path d="M4.5 20.5c1.3-3.6 4.1-5.3 7.5-5.3s6.2 1.7 7.5 5.3"/>',
    listCheck: '<path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17M11 6h10M11 12h10M11 18h10"/>',
    fileSearch: '<path d="M14 3H6a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 6 21h12a1.5 1.5 0 0 0 1.5-1.5V8.5z"/><circle cx="11.5" cy="13" r="2.7"/><path d="m13.5 15 2.5 2.5"/>',
    layout: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9.5 4v16"/>',
    chartPie: '<path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M15 2.5a8 8 0 0 1 6.5 6.5H15z"/>',
    media: '<rect x="3" y="5" width="13" height="11" rx="2"/><path d="m7.5 16 3-4 2.5 3 1.5-1.5 1.5 2.5"/><path d="M19.5 8.5 21 8v9.5c0 1-1 2-2 2h-9"/>',
    calendarUser: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/><circle cx="12" cy="14.5" r="1.8"/><path d="M8.5 19.5c.7-1.7 2-2.5 3.5-2.5s2.8.8 3.5 2.5"/>',
    users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3 20c1-3 3.3-4.5 6-4.5s5 1.5 6 4.5"/><circle cx="17" cy="9.5" r="2.5"/><path d="M16.5 15.5c2.3.2 4 1.5 4.7 4"/>',
    building: '<rect x="4" y="3" width="10" height="18" rx="1"/><path d="M14 9h5a1 1 0 0 1 1 1v11"/><path d="M7.5 7h1M10.5 7h1M7.5 11h1M10.5 11h1M7.5 15h1M10.5 15h1M2.5 21h19"/>',
    userGear: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c1-3.2 3.5-4.8 6.5-4.8"/><circle cx="17.5" cy="16.5" r="2.2"/><path d="M17.5 12.8v1.5M17.5 18.7v1.5M21 14.5l-1.3.8M15.3 17.7l-1.3.8M14 14.5l1.3.8M19.7 17.7l1.3.8"/>',
    idCard: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><circle cx="8" cy="11" r="2"/><path d="M5 16.5c.6-1.5 1.7-2.2 3-2.2s2.4.7 3 2.2M14.5 9.5H19M14.5 13H19"/>',
    gradCap: '<path d="m12 4 10 4.5L12 13 2 8.5z"/><path d="M6.5 10.8V16c0 1.2 2.5 2.5 5.5 2.5s5.5-1.3 5.5-2.5v-5.2M22 8.5V14"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
    shield: '<path d="M12 3 4.5 5.8V11c0 5 3.2 8.3 7.5 10 4.3-1.7 7.5-5 7.5-10V5.8z"/><path d="m9 11.5 2 2 4-4"/>',
    logout: '<path d="M14 4h5a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 19 20h-5M10 8l-4 4 4 4M6 12h10"/>',
    upload: '<path d="M12 15V4M7.5 8 12 3.5 16.5 8"/><path d="M4 15v4a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-4"/>',
    invoice: '<path d="M6 3h12a1 1 0 0 1 1 1v17l-3-1.8L13 21l-3-1.8L7 21l-2-1.2V4a1 1 0 0 1 1-1z"/><path d="M9 8h6M9 12h6"/>',
    clipboard: '<rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 5a3 3 0 0 1 6 0"/><path d="M9 11h6M9 15h4"/>',
    userPlus: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c1-3.2 3.5-4.8 6.5-4.8s5.5 1.6 6.5 4.8"/><path d="M18.5 8v6M15.5 11h6"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'
  };
  var ICONS = {};
  Object.keys(P).forEach(function (k) { ICONS[k] = svg(P[k]); });
  ICONS._menu = function (name) { return P[name] ? svg(P[name], 12) : ""; };

  /* ---------- package defaults (centrally controlled) ---------- */
  var DEFAULT_LINKS = [
    { id: "home",       label: "Home",       icon: "home",       href: "/" },
    { id: "inbox",      label: "Inbox",      icon: "inbox",      href: "/inbox" },
    { id: "projects",   label: "Projects",   icon: "rocket",     href: "/projects" },
    { id: "starred",    label: "Starred",    icon: "star",       href: "/starred" },
    { id: "timesheets", label: "Timesheets", icon: "timesheets", href: "/timesheets" },
    /* Apps menu structure mirrors the live nav (hrefs to be confirmed centrally) */
    { id: "apps", label: "Apps", icon: "apps", menu: { sections: [
      { title: "Explore", items: [
        { label: "Task Explorer", icon: "listCheck", href: "#" },
        { label: "All Reviews", icon: "fileSearch", href: "#" },
        { label: "Dashboards", icon: "layout", href: "#" },
        { label: "Reports", icon: "chartPie", href: "#" },
        { label: "The New Mine", icon: "media", href: "#" }] },
      { title: "Collaborate", items: [
        { label: "Resource Scheduler", icon: "calendarUser", href: "#" }] },
      { title: "Admin", items: [
        { label: "Manage Users & Groups", icon: "users", href: "#" },
        { label: "Manage Brands, Offices & Products", icon: "building", href: "#" },
        { label: "Portal Manager", icon: "layout", href: "#" },
        { label: "Bulk Amendments", icon: "layout", href: "#" }] },
      { items: [{ label: "Account Settings", icon: "userGear", href: "#" }] }
    ] } }
  ];
  var DEFAULT_PLUS_MENU = { sections: [
    { title: "Collaboration", items: [
      { label: "Create Project", icon: "rocket", href: "#" },
      { label: "Create Task", icon: "listCheck", href: "#" },
      { label: "Create Review", icon: "fileSearch", href: "#" },
      { label: "Upload File", icon: "upload", href: "#" },
      { label: "Job Builder", icon: "clipboard", href: "#" }] },
    { title: "Finances", items: [
      { label: "Create Estimate", icon: "invoice", href: "#" },
      { label: "Create Purchase Order", icon: "clipboard", href: "#" },
      { label: "Create Invoices", icon: "invoice", href: "#" }] },
    { title: "Resources", items: [
      { label: "Add User", icon: "userPlus", href: "#" }] }
  ] };
  var DEFAULT_USER_MENU = { sections: [{ items: [
    { label: "My Details", icon: "idCard", href: "#" },
    { label: "Training & Support", icon: "gradCap", href: "#" },
    { label: "Change Password", icon: "lock", href: "#" },
    { label: "Privacy Policy", icon: "shield", href: "#" },
    { label: "Logout", icon: "logout", href: "#" }] }] };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function initials(name) {
    var p = String(name || "").trim().split(/\s+/);
    return ((p[0] || "")[0] || "") + ((p[1] || "")[0] || "");
  }

  /* ---------- shared menu-panel CSS (used by nav + banner) ---------- */
  var PANEL_CSS = "\
.panel { position:absolute; top:calc(100% - 4px); background:var(--pp-surface,#fff); border:1px solid var(--pp-line-strong,#cac9cc); border-radius:4px; box-shadow:0 10px 15px -3px rgba(0,0,0,.1), 0 4px 6px -4px rgba(0,0,0,.1); padding:4px 5px; z-index:120; display:none; text-align:left; }\
.panel.open { display:block; }\
.panel--wide { width:min(528px, 94vw); }\
.panel--narrow { width:272px; }\
.sect-title { display:block; font:700 11px/1.25 inherit; letter-spacing:1.1px; text-transform:uppercase; color:#666; padding:10px 10px 6px; }\
.mrow { display:flex; align-items:center; gap:8px; height:32px; padding:0 12px; margin:2px 0; border-radius:4px; color:#222; font:700 12px/1.3 inherit; text-decoration:none; cursor:pointer; white-space:nowrap; }\
.mrow svg { flex:none; }\
.mrow span { overflow:hidden; text-overflow:ellipsis; }\
.mrow:hover { background:#f2f2f2; }\
.mfoot { display:flex; justify-content:space-between; align-items:center; border-top:1px solid var(--pp-line,#e5e8ec); margin-top:4px; padding:9px 12px 6px; }\
.mfoot a { color:#18181a; font:700 12px/1 inherit; text-decoration:none; }\
.mfoot a:hover { text-decoration:underline; }\
.mload { padding:12px; font:400 12px/1.4 inherit; color:#666; }";

  function renderMenuHtml(def) {
    if (!def || !def.sections) return "";
    var h = "";
    def.sections.forEach(function (s) {
      if (s.title) h += '<span class="sect-title">' + esc(s.title) + "</span>";
      (s.items || []).forEach(function (it) {
        h += '<a class="mrow" href="' + esc(it.href || "#") + '"' + (it.id ? ' data-mid="' + esc(it.id) + '"' : "") + ">" +
          (it.iconHtml || ICONS._menu(it.icon) || "") + "<span>" + esc(it.label) + "</span></a>";
      });
    });
    if (def.footer && def.footer.length) {
      h += '<div class="mfoot">' + def.footer.map(function (f) {
        return '<a href="' + esc(f.href || "#") + '"' + (f.id ? ' data-mid="' + esc(f.id) + '"' : "") + ">" + esc(f.label) + "</a>";
      }).join("") + "</div>";
    }
    return h;
  }

  /** Menu item activation: fires pronto:menuselect, runs item.onClick when given
   *  (e.g. Logout), and closes the panel. Plain hrefs navigate as normal links. */
  function wireMenuActions(panel, host, closeFn, getDef, menuId) {
    panel.addEventListener("click", function (ev) {
      var a = null, path = ev.composedPath ? ev.composedPath() : [ev.target];
      for (var i = 0; i < path.length; i++) {
        if (path[i] === panel) break;
        if (path[i] && path[i].tagName === "A") { a = path[i]; break; }
      }
      if (!a) return;
      var def = getDef() || {};
      var flat = [];
      (def.sections || []).forEach(function (s) { (s.items || []).forEach(function (it) { flat.push(it); }); });
      (def.footer || []).forEach(function (f) { flat.push(f); });
      var mid = a.getAttribute("data-mid");
      var label = (a.textContent || "").trim();
      var item = null;
      for (var j = 0; j < flat.length; j++) {
        if (mid ? flat[j].id === mid : flat[j].label === label) { item = flat[j]; break; }
      }
      if (!item) return;
      host.dispatchEvent(new CustomEvent("pronto:menuselect", {
        bubbles: true, detail: { menu: menuId, id: item.id || null, label: item.label }
      }));
      if (typeof item.onClick === "function") {
        ev.preventDefault(); closeFn();
        try { item.onClick(item); } catch (e) {}
      } else if (!item.href || item.href === "#") {
        ev.preventDefault(); closeFn();
      } else {
        closeFn();
      }
    });
  }

  /* Wire toggle behaviour for triggers/panels inside a shadow root.
     One menu open per root; outside click + Escape close. */
  function menuController(root, host) {
    var openPanel = null, openTrigger = null;
    function close() {
      if (openPanel) { openPanel.classList.remove("open"); openPanel = null; }
      if (openTrigger) { openTrigger.setAttribute("aria-expanded", "false"); openTrigger = null; }
      document.removeEventListener("click", onDoc, true);
      document.removeEventListener("keydown", onKey, true);
    }
    function onDoc(e) { if (e.composedPath().indexOf(host) === -1) close(); }
    function onKey(e) { if (e.key === "Escape") close(); }
    function toggle(trigger, panel, onOpen) {
      if (openPanel === panel) { close(); return; }
      close();
      openPanel = panel; openTrigger = trigger;
      panel.classList.add("open");
      trigger.setAttribute("aria-expanded", "true");
      document.addEventListener("click", onDoc, true);
      document.addEventListener("keydown", onKey, true);
      if (onOpen) onOpen(panel);
    }
    return { toggle: toggle, close: close };
  }

  /* =========================== <pronto-nav> =========================== */
  var NAV_CSS = "\
:host { display:block; position:sticky; top:0; z-index:900; font:14px/1.4 var(--pp-font, Lato, -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif); }\
* { box-sizing:border-box; }\
.bar { position:relative; display:grid; grid-template-columns:1fr auto 1fr; align-items:center; height:var(--pp-nav-h,56px); background:var(--pp-surface,#fff); padding:0 var(--pp-gutter,40px); border-bottom:1px solid var(--pp-line,#e5e8ec); }\
a { color:inherit; text-decoration:none; }\
.logo { justify-self:start; display:flex; align-items:baseline; gap:5px; white-space:nowrap; }\
.logo img { height:var(--pp-logo-h,22px); width:auto; display:block; }\
.logo .havas { font-weight:800; font-size:19px; letter-spacing:.5px; color:var(--pp-ink,#18181a); }\
.logo .pronto { font-weight:800; font-style:italic; font-size:21px; color:var(--pp-ink,#18181a); }\
.logo .bang { font-weight:900; font-style:italic; font-size:21px; color:var(--pp-red,#ed0007); margin-left:-2px; }\
nav { display:flex; align-items:center; gap:4px; }\
nav > a, nav > button { display:flex; align-items:center; gap:6px; height:36px; padding:0 12px; border:0; background:none; border-radius:4px; font:700 13px/1 inherit; color:#18181a; cursor:pointer; }\
nav > a:hover, nav > button:hover, nav > .active { background:#f2f2f2; }\
nav svg { flex:none; }\
.right { justify-self:end; display:flex; align-items:center; gap:12px; }\
.search { position:relative; display:flex; align-items:center; }\
.search input { width:min(200px,26vw); height:34px; padding:8px 8px 8px 30px; border:1px solid var(--pp-line-strong,#cac9cc); border-radius:4px; background:var(--pp-surface,#fff); font:400 12px/1 inherit; color:#18181a; }\
.search input::placeholder { color:#8a8a8f; font-style:italic; }\
.search input:focus { outline:none; border-color:#8a8a8f; }\
.search .mag { position:absolute; left:9px; color:#66666b; display:flex; pointer-events:none; }\
.iconbtn { display:flex; align-items:center; justify-content:center; width:36px; height:36px; border:0; border-radius:4px; background:transparent; color:#18181a; cursor:pointer; }\
.iconbtn:hover { background:#f2f2f2; }\
.avatar { width:36px; height:36px; border-radius:50%; overflow:hidden; background:#4b5563; color:#fff; display:flex; align-items:center; justify-content:center; font:700 13px/1 inherit; flex:none; cursor:pointer; border:0; padding:0; }\
.avatar img { width:100%; height:100%; object-fit:cover; display:block; }\
" + PANEL_CSS + "\
@media (max-width:1080px){ nav > a span, nav > button span { display:none; } .search input { width:34vw; } }";

  function ProntoNavFactory() {
    function render(host) {
      var cfg = CFG();
      var links = cfg.links || DEFAULT_LINKS;
      var root = (cfg.appRoot != null ? cfg.appRoot : host.getAttribute("app-root")) || "";
      var active = host.getAttribute("active") || cfg.active || "";
      var user = cfg.user && cfg.user !== "auto" ? cfg.user : {};
      var search = cfg.search || {};

      var navHtml = links.map(function (l) {
        var icon = l.iconHtml || ICONS[l.icon || l.id] || "";
        var inner = icon + "<span>" + esc(l.label) + "</span>";
        var cls = l.id === active ? ' class="active"' : "";
        var menu = l.menu || (cfg.menus && cfg.menus[l.id]);   /* cfg.menus attaches menus to default links */
        if (menu) return "<button" + cls + ' data-menu="' + esc(l.id) + '" aria-haspopup="true" aria-expanded="false">' + inner + "</button>";
        var href = /^(https?:)?\/\//.test(l.href || "") ? l.href : root + (l.href || "#");
        return '<a href="' + esc(href) + '"' + cls + ">" + inner + "</a>";
      }).join("");

      var logo, logoChain = null;
      if (cfg.logoHtml) { logo = cfg.logoHtml; }
      else {
        logoChain = [];
        if (cfg.logoSrc) logoChain.push(cfg.logoSrc);
        else {
          if (SCRIPT_BASE) logoChain.push(SCRIPT_BASE + "/img/havas-pronto-wide.png");
          logoChain.push(LOGO_REMOTE);
        }
        logo = '<img src="' + esc(logoChain.shift()) + '" alt="Havas Pronto"/>';
      }

      var avatar = user.avatarUrl
        ? '<img src="' + esc(user.avatarUrl) + '" alt="' + esc(user.name || "") + '"/>'
        : (user.name ? esc(initials(user.name).toUpperCase()) : ICONS.user);

      var plusMenu = cfg.plusMenu !== undefined ? cfg.plusMenu : DEFAULT_PLUS_MENU;
      var userMenu = cfg.userMenu !== undefined ? cfg.userMenu : DEFAULT_USER_MENU;

      host.shadowRoot.innerHTML =
        "<style>" + NAV_CSS + "</style>" +
        '<div class="bar">' +
          '<a class="logo" href="' + esc(root + (cfg.homeHref || "/")) + '" aria-label="Pronto home">' + logo + "</a>" +
          "<nav>" + navHtml + "</nav>" +
          '<div class="right">' +
            (search.hidden ? "" :
              '<form class="search" action="' + esc(search.href || root + "/search") + '" method="get">' +
                '<span class="mag">' + ICONS._menu("search") + "</span>" +
                '<input type="search" name="' + esc(search.param || "q") + '" placeholder="' +
                  esc(search.placeholder || "Search Pronto...") + '" aria-label="Search"/></form>') +
            (plusMenu ? '<button class="iconbtn" data-menu="_plus" title="Create" aria-haspopup="true" aria-expanded="false">' + ICONS.plus + "</button>" : "") +
            '<button class="avatar" data-menu="_user" title="' + esc(user.name || "Account") + '" aria-haspopup="true" aria-expanded="false">' + avatar + "</button>" +
          "</div>" +
        "</div>";

      var bar = host.shadowRoot.querySelector(".bar");
      var menus = menuController(host.shadowRoot, host);
      host._menus = menus;

      /* build panels lazily; position on open */
      function menuDefFor(id) {
        if (id === "_plus") return plusMenu;
        if (id === "_user") return userMenu;
        var link = links.filter(function (l) { return l.id === id; })[0];
        return (link && link.menu) || (CFG().menus && CFG().menus[id]);
      }
      host.shadowRoot.querySelectorAll("[data-menu]").forEach(function (trigger) {
        trigger.addEventListener("click", function (e) {
          e.preventDefault();
          var id = trigger.getAttribute("data-menu");
          var def = menuDefFor(id);
          var panel = bar.querySelector('.panel[data-for="' + id + '"]');
          if (!panel) {
            panel = document.createElement("div");
            panel.className = "panel " + (id === "_plus" || id === "_user" ? "panel--narrow" : "panel--wide");
            panel.setAttribute("data-for", id);
            bar.appendChild(panel);
            wireMenuActions(panel, host, menus.close, function () { return panel._def; }, id);
          }
          menus.toggle(trigger, panel, function () {
            /* content */
            if (def === "auto" && typeof CFG().fetchMenu === "function") {
              panel._def = null;
              panel.innerHTML = '<div class="mload">Loading&hellip;</div>';
              Promise.resolve(CFG().fetchMenu(id)).then(function (d) {
                if (panel.classList.contains("open")) { panel._def = d; panel.innerHTML = renderMenuHtml(d); }
              }).catch(function () { panel.innerHTML = '<div class="mload">Unavailable</div>'; });
            } else {
              panel._def = def;
              panel.innerHTML = renderMenuHtml(def);
            }
            /* position: right-aligned for right-cluster triggers, else centred under trigger, clamped */
            var br = bar.getBoundingClientRect(), tr = trigger.getBoundingClientRect();
            panel.style.left = "auto"; panel.style.right = "auto";
            if (id === "_plus" || id === "_user") {
              panel.style.right = Math.max(8, br.right - tr.right) + "px";
            } else {
              var w = Math.min(528, innerWidth * 0.94);
              var left = tr.left - br.left + tr.width / 2 - w / 2;
              left = Math.max(8 - br.left, Math.min(left, br.width - w - 8));
              panel.style.left = left + "px";
            }
            host.dispatchEvent(new CustomEvent("pronto:menu", { bubbles: true, detail: { id: id } }));
          });
        });
      });

      /* logo fallback chain */
      var logoImg = host.shadowRoot.querySelector(".logo img");
      if (logoImg && logoChain) {
        logoImg.addEventListener("error", function () {
          if (logoChain.length) logoImg.src = logoChain.shift();
          else host.shadowRoot.querySelector(".logo").innerHTML = LOGO_TEXT;
        });
      }
    }

    var El = function () {
      var self = Reflect.construct(HTMLElement, [], El);
      self.attachShadow({ mode: "open" });
      return self;
    };
    El.prototype = Object.create(HTMLElement.prototype, { constructor: { value: El } });
    Object.setPrototypeOf(El, HTMLElement);
    El.prototype.connectedCallback = function () {
      render(this);
      var cfg = CFG(), host = this;
      if (cfg.user === "auto" && typeof cfg.fetchUser === "function") {
        Promise.resolve(cfg.fetchUser()).then(function (u) {
          if (u) { cfg.user = u; render(host); }
        }).catch(function () {});
      }
    };
    El.prototype.disconnectedCallback = function () { if (this._menus) this._menus.close(); };
    El.prototype.refresh = function () { if (this._menus) this._menus.close(); render(this); };
    El.observedAttributes = ["active", "app-root"];
    El.prototype.attributeChangedCallback = function () { if (this.shadowRoot) this.refresh(); };
    return El;
  }

  /* ========================== <pronto-banner> ========================== */
  var BANNER_CSS = "\
:host { display:block; position:relative; z-index:500; padding:16px var(--pp-gutter,40px) 20px; font:14px/1.4 var(--pp-font, Lato, -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif); }\
* { box-sizing:border-box; }\
.banner { position:relative; display:flex; align-items:center; gap:16px; min-height:76px; padding:14px 18px; border-radius:var(--pp-radius,10px); background:#0c0d0f; color:#fff; }\
.bg { position:absolute; inset:0; border-radius:inherit; overflow:hidden; pointer-events:none; }\
.bg::before { content:''; position:absolute; inset:0; background:\
 radial-gradient(60% 130% at 84% 20%, rgba(237,0,7,.55), transparent 60%),\
 radial-gradient(45% 110% at 70% 100%, rgba(150,0,20,.45), transparent 65%),\
 linear-gradient(100deg, #000 55%, #1a0407 78%, #000); }\
.banner > *:not(.bg) { position:relative; }\
.fav { width:40px; height:40px; border-radius:9px; border:0; background:#fff; color:#3c4350; display:flex; align-items:center; justify-content:center; cursor:pointer; flex:none; }\
.fav:hover { color:var(--pp-red,#ed0007); }\
.titles { min-width:0; }\
.title { display:flex; align-items:center; gap:8px; font-size:18px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }\
.title .info { display:inline-flex; color:rgba(255,255,255,.75); cursor:help; }\
.title .seg-dim { color:rgba(255,255,255,.68); font-weight:600; }\
.title a.seg-dim { text-decoration:none; }\
.title a.seg-dim:hover { color:#fff; }\
.title .sep { color:rgba(255,255,255,.42); font-weight:400; margin:0 2px; }\
.subtitle { font-size:12.5px; color:rgba(255,255,255,.72); margin-top:2px; }\
.actions { position:relative; margin-left:auto; display:flex; align-items:center; gap:8px; }\
.pill { display:inline-flex; align-items:center; gap:8px; background:#fff; color:var(--pp-ink,#18181a); font:700 13.5px/1 inherit; border:0; border-radius:999px; padding:10px 16px; cursor:pointer; text-decoration:none; }\
.pill .tick { display:inline-flex; color:var(--pp-primary,#4f46e5); }\
.pill:hover { background:#f1f2f4; }\
.chev { width:38px; height:38px; border-radius:999px; border:0; background:#fff; color:var(--pp-ink,#18181a); display:flex; align-items:center; justify-content:center; cursor:pointer; }\
.chev:hover { background:#f1f2f4; }\
::slotted(*) { position:relative; }\
" + PANEL_CSS + "\
.actions .panel { top:calc(100% + 6px); right:0; color:#222; }";

  function ProntoBannerFactory() {
    function render(host) {
      var cfg = CFG();
      var title = host.getAttribute("page-title") || cfg.pageTitle || document.title;
      var subtitle = host.getAttribute("subtitle") || cfg.subtitle || "";
      var infoTip = host.getAttribute("info") || cfg.pageInfo || "";
      var hp = cfg.homepage;

      /* Breadcrumb mode: cfg.breadcrumb = ["App name", …, "Current page"]
         (segments may also be {label, href}). Earlier segments render dimmed
         (linked when href given), separated by " / "; the last is the title. */
      var titleHtml = esc(title);
      if (Array.isArray(cfg.breadcrumb) && cfg.breadcrumb.length) {
        titleHtml = cfg.breadcrumb.map(function (seg, i) {
          var label = esc(typeof seg === "string" ? seg : seg.label);
          var href = seg && seg.href;
          var last = i === cfg.breadcrumb.length - 1;
          if (last) return "<span>" + label + "</span>";
          var el = href ? '<a class="seg-dim" href="' + esc(href) + '">' + label + "</a>"
                        : '<span class="seg-dim">' + label + "</span>";
          return el + '<span class="sep">/</span>';
        }).join("");
      }

      host.shadowRoot.innerHTML =
        "<style>" + BANNER_CSS + "</style>" +
        '<div class="banner"><div class="bg"></div>' +
          '<button class="fav" title="Favourite this page" aria-label="Favourite">' + ICONS.star + "</button>" +
          '<div class="titles">' +
            '<div class="title">' + titleHtml +
              (infoTip ? '<span class="info" title="' + esc(infoTip) + '">' + ICONS.info + "</span>" : "") + "</div>" +
            (subtitle ? '<div class="subtitle">' + esc(subtitle) + "</div>" : "") +
          "</div>" +
          '<div class="actions"><slot name="actions"></slot>' +
            (hp === false ? "" :
              '<a class="pill" href="' + esc((hp && hp.href) || "#") + '">' +
                ((hp && hp.checked) !== false ? '<span class="tick">' + ICONS.check + "</span>" : "") +
                esc((hp && hp.label) || "My Homepage") + "</a>" +
              ((hp && hp.menu) ?
                '<button class="chev" aria-label="Page options" aria-haspopup="true" aria-expanded="false">' + ICONS.chevron + "</button>" +
                '<div class="panel panel--narrow" data-for="_page"></div>' : "")) +
          "</div>" +
        "</div>";

      host.shadowRoot.querySelector(".fav").addEventListener("click", function () {
        host.dispatchEvent(new CustomEvent("pronto:favourite", { bubbles: true }));
      });

      var chev = host.shadowRoot.querySelector(".chev");
      if (chev) {
        var menus = menuController(host.shadowRoot, host);
        host._menus = menus;
        var panel = host.shadowRoot.querySelector('[data-for="_page"]');
        wireMenuActions(panel, host, menus.close, function () { return CFG().homepage && CFG().homepage.menu; }, "_page");
        chev.addEventListener("click", function () {
          menus.toggle(chev, panel, function () {
            panel.innerHTML = renderMenuHtml(cfg.homepage.menu);
          });
        });
      }
    }

    var El = function () {
      var self = Reflect.construct(HTMLElement, [], El);
      self.attachShadow({ mode: "open" });
      return self;
    };
    El.prototype = Object.create(HTMLElement.prototype, { constructor: { value: El } });
    Object.setPrototypeOf(El, HTMLElement);
    El.prototype.connectedCallback = function () { render(this); };
    El.prototype.disconnectedCallback = function () { if (this._menus) this._menus.close(); };
    El.prototype.refresh = function () { if (this._menus) this._menus.close(); render(this); };
    El.observedAttributes = ["page-title", "subtitle", "info"];
    El.prototype.attributeChangedCallback = function () { if (this.shadowRoot) this.refresh(); };
    return El;
  }

  customElements.define("pronto-nav", ProntoNavFactory());
  customElements.define("pronto-banner", ProntoBannerFactory());
})();
