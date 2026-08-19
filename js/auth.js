/* =========================================================================
   auth.js - login gate (pages/login.html).
   Standalone (no app shell). Self-signup is disabled — accounts are created by
   an admin — so this page only logs in. Talks to /api/auth/login, then routes
   to onboarding (no client yet) or the dashboard. The server also enforces auth
   via a before_request guard.
   ========================================================================= */
(function(){
  const el = (id) => document.getElementById(id);
  const form = el("authForm"), errBox = el("authErr");
  const submit = el("authSubmit");

  function showErr(msg){ errBox.textContent = msg; errBox.style.display = "block"; }
  function hideErr(){ errBox.style.display = "none"; }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideErr();
    const email = el("fEmail").value.trim();
    const password = el("fPass").value;
    if(!email || !password){ showErr("Email and password are required."); return; }

    submit.disabled = true; const orig = submit.textContent; submit.textContent = "Please wait…";
    try{
      const res = await fetch("/api/auth/login", {method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({email, password})});
      const j = await res.json().catch(()=>({}));
      if(!res.ok || !j.ok){ showErr(j.error || "Something went wrong. Please try again."); return; }
      // First login (admin-created account) -> must set a new password before anything else.
      if(j.mustChangePassword){ window.location.href = "/change-password"; return; }
      // Admins manage users only (no client / no mapping) -> straight to the Admin page.
      if(j.user && j.user.isAdmin){ window.location.href = "/pages/admin.html"; return; }
      // login -> onboarding if no client yet, else the SPA shell (persistent sidebar).
      if(j.needsOnboarding) window.location.href = "/onboarding";
      else window.location.href = "/pages/app.html#dashboard.html";
    }catch(err){
      showErr("Cannot reach the server. Is the backend running?");
    }finally{
      submit.disabled = false; submit.textContent = orig;
    }
  });
})();
