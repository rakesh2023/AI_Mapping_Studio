/* =========================================================================
   app-shell.js — SPA shell controller (pages/app.html).

   Renders the sidebar + header ONCE (via initShell) and hosts every page in an
   <iframe>. Clicking a sidebar item swaps only the iframe's document — the shell
   (sidebar/header) never reloads, so there is NO full-page refresh.

   Routing uses the URL hash: pages/app.html#dashboard.html. Back/forward and
   deep links work; navigations triggered inside a page (buttons/links) are
   detected on the iframe's load event and kept in sync with the sidebar + hash.
   ========================================================================= */
(function(){
  const DEFAULT_PAGE = "dashboard.html";
  // Pages that must NOT be framed (they are their own top-level flows).
  const NON_FRAMED = ["app.html", "login.html", "onboarding.html", "admin.html"];

  function frame(){ return document.getElementById("appFrame"); }

  // "dashboard.html" or "mapping-workspace.html?search=x" from the hash.
  function routeFromHash(){
    const h = (location.hash || "").replace(/^#/, "").trim();
    const base = h.split("?")[0];
    if(h && base.endsWith(".html") && NON_FRAMED.indexOf(base) === -1) return h;
    return DEFAULT_PAGE;
  }
  function baseOf(page){ return (page || "").split("?")[0]; }

  function setActive(page){
    const base = baseOf(page);
    document.querySelectorAll("#sidebar-container a.nav-link").forEach(a => {
      a.classList.toggle("active", a.getAttribute("href") === base);
    });
  }

  // Load `page` (relative to /pages/) into the iframe if it isn't already showing it.
  function navigateTo(page, pushHash){
    const f = frame();
    const desiredPath = "/pages/" + baseOf(page);
    let currentPath = null;
    try{ currentPath = f.contentWindow && f.contentWindow.location.pathname; }catch(e){ /* not loaded yet */ }
    if(currentPath !== desiredPath){
      f.src = page;   // relative to app.html (/pages/) -> loads /pages/<page>
    }
    setActive(page);
    if(pushHash){ if(routeFromHash() !== page) location.hash = page; }
    else { try{ history.replaceState(null, "", "#" + page); }catch(e){} }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const initial = routeFromHash();
    await initShell(baseOf(initial));   // builds sidebar/header in THIS (top) window; gates auth
    if(document.body.classList.contains("in-frame")) return;   // safety: shell is never itself framed

    navigateTo(initial, false);         // load the first page into the iframe

    // Intercept sidebar link clicks -> swap the iframe instead of navigating the shell.
    const sb = document.getElementById("sidebar-container");
    if(sb){
      sb.addEventListener("click", (e) => {
        const a = e.target.closest("a.nav-link");
        if(!a) return;
        const href = a.getAttribute("href") || "";
        if(!href.endsWith(".html")) return;
        // Admin/login/onboarding are full-page flows — let them navigate normally.
        if(NON_FRAMED.indexOf(href) !== -1) return;
        e.preventDefault();
        navigateTo(href, true);
      });
    }

    // Back/forward or manual hash edit.
    window.addEventListener("hashchange", () => navigateTo(routeFromHash(), false));

    // Keep the sidebar highlight + hash in sync when navigation happens INSIDE a page
    // (e.g. an empty-state button or window.location inside the iframe). Same-origin,
    // so reading the iframe location is allowed.
    frame().addEventListener("load", () => {
      let page = null;
      try{
        const loc = frame().contentWindow.location;
        page = loc.pathname.split("/").pop() + (loc.search || "");
      }catch(e){ return; }
      const base = baseOf(page);
      if(!base.endsWith(".html") || base === "app.html") return;
      setActive(page);
      try{ history.replaceState(null, "", "#" + page); }catch(e){}
    });

    // The global search lives in the shell header; route it to the iframe (initShell
    // wired it to window.location, which would reload the shell — override that here).
    const search = document.getElementById("globalSearchInput");
    if(search){
      const fresh = search.cloneNode(true);            // drop initShell's keydown handler
      search.parentNode.replaceChild(fresh, search);
      fresh.addEventListener("keydown", (e) => {
        if(e.key === "Enter" && fresh.value.trim()){
          navigateTo("mapping-workspace.html?search=" + encodeURIComponent(fresh.value.trim()), true);
        }
      });
    }
  });
})();
