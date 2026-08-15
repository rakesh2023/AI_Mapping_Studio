/* =========================================================================
   onboarding.js - first-run "Client Details" capture (pages/onboarding.html).
   Requires a logged-in session (redirects to /login otherwise). Creates a
   Client for the user, which becomes their active client, then -> dashboard.
   ========================================================================= */
(function(){
  const el = (id) => document.getElementById(id);
  const form = el("obForm"), errBox = el("obErr"), submit = el("obSubmit");

  // SEC-005: this standalone page doesn't load common.js's fetch wrapper, so read
  // the double-submit token here and attach it to the (non-auth) client-create POST.
  const csrfToken = () => decodeURIComponent(
    (document.cookie.split("; ").find(c => c.startsWith("csrf_token=")) || "").split("=").slice(1).join("="));

  function showErr(msg){ errBox.textContent = msg; errBox.style.display = ""; }
  function hideErr(){ errBox.style.display = "none"; }

  // Guard: must be logged in to onboard. Admins don't create clients — send them
  // straight to the Admin page instead of the onboarding form.
  (async function ensureAuthed(){
    try{
      const res = await fetch("/api/auth/me", {headers:{"Accept":"application/json"}});
      if(res.status === 401){ window.location.href = "/login"; return; }
      const j = await res.json().catch(()=>({}));
      if(j && j.user && j.user.isAdmin){ window.location.href = "/pages/admin.html"; return; }
    }catch(e){ /* backend down — let the form submit surface it */ }
  })();

  el("obLogout").addEventListener("click", async () => {
    try{ await fetch("/api/auth/logout", {method:"POST"}); }catch(e){}
    window.location.href = "/login";
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideErr();
    const name = el("cName").value.trim();
    if(!name){ showErr("Client name is required."); return; }
    const config = {
      migrationType: el("cMigration").value || "",
      sourceApplication: el("cSourceApp").value.trim(),
      targetApplication: el("cTargetApp").value.trim(),
      notes: el("cNotes").value.trim()
    };
    const body = {name: name, industry: el("cIndustry").value.trim(), config: config};

    submit.disabled = true; const orig = submit.innerHTML; submit.innerHTML = "Creating…";
    try{
      const res = await fetch("/api/clients", {method:"POST", headers:{"Content-Type":"application/json", "X-CSRF-Token": csrfToken()}, body: JSON.stringify(body)});
      const j = await res.json().catch(()=>({}));
      if(res.status === 401){ window.location.href = "/login"; return; }
      if(!res.ok || !j.ok){ showErr(j.error || "Could not create the client. Please try again."); return; }
      window.location.href = "/pages/app.html#dashboard.html";
    }catch(err){
      showErr("Cannot reach the server. Is the backend running?");
    }finally{
      submit.disabled = false; submit.innerHTML = orig;
    }
  });
})();
