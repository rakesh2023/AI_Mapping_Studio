/* =========================================================================
   change-password.js — standalone password-change page (pages/change-password.html).
   Used both for the forced first-login change (the server guard redirects here and
   blocks everything else until done) and as a clean URL a user can visit. Requires a
   logged-in session; posts to /api/auth/change-password (which is CSRF-exempt, so no
   manual token needed). On success -> back into the app (the guard routes onward).
   ========================================================================= */
(function(){
  const el = (id) => document.getElementById(id);
  const form = el("cpForm"), errBox = el("cpErr"), submit = el("cpSubmit");

  function showErr(msg){ errBox.textContent = msg; errBox.style.display = ""; }
  function hideErr(){ errBox.style.display = "none"; }

  // Must be logged in. Show whether this is a forced change (and the account email).
  (async function ensureAuthed(){
    try{
      const res = await fetch("/api/auth/me", {headers:{"Accept":"application/json"}});
      if(res.status === 401){ window.location.href = "/login"; return; }
      const j = await res.json().catch(()=>({}));
      if(j && j.user){
        if(j.user.email) el("cpSub").textContent = "Set a new password for " + j.user.email + ".";
        if(j.user.mustChangePassword) el("cpForcedNote").style.display = "";
      }
    }catch(e){ /* backend down — the submit will surface it */ }
  })();

  el("cpLogout").addEventListener("click", async () => {
    try{ await fetch("/api/auth/logout", {method:"POST"}); }catch(e){}
    window.location.href = "/login";
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideErr();
    const current = el("cpCurrent").value;
    const next = el("cpNew").value;
    const confirm = el("cpConfirm").value;
    if(!current || !next){ showErr("Enter your current and new password."); return; }
    if(next.length < 8){ showErr("New password must be at least 8 characters."); return; }
    if(next !== confirm){ showErr("The new passwords do not match."); return; }
    if(next === current){ showErr("The new password must be different from your current password."); return; }

    submit.disabled = true; const orig = submit.innerHTML; submit.innerHTML = "Updating…";
    try{
      const res = await fetch("/api/auth/change-password", {method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({currentPassword: current, newPassword: next})});
      const j = await res.json().catch(()=>({}));
      if(res.status === 401){ window.location.href = "/login"; return; }
      if(!res.ok || !j.ok){ showErr(j.error || "Could not change the password. Please try again."); return; }
      // Cleared the gate — go back into the app (guard routes to onboarding if needed).
      window.location.href = "/pages/app.html#dashboard.html";
    }catch(err){
      showErr("Cannot reach the server. Is the backend running?");
    }finally{
      submit.disabled = false; submit.innerHTML = orig;
    }
  });
})();
