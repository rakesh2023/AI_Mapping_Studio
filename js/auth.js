/* =========================================================================
   auth.js - login / signup gate (pages/login.html).
   Standalone (no app shell). Talks to /api/auth/*, then routes to onboarding
   or the dashboard. The server also enforces auth via a before_request guard.
   ========================================================================= */
(function(){
  let mode = "login";   // "login" | "signup"

  const el = (id) => document.getElementById(id);
  const form = el("authForm"), errBox = el("authErr");
  const nameGroup = el("nameGroup"), pwHint = el("pwHint");
  const submit = el("authSubmit"), foot = el("authFoot");
  const passInput = el("fPass");

  function setMode(m){
    mode = m;
    el("tabLogin").classList.toggle("active", m === "login");
    el("tabSignup").classList.toggle("active", m === "signup");
    nameGroup.style.display = (m === "signup") ? "" : "none";
    pwHint.style.display = (m === "signup") ? "" : "none";
    submit.textContent = (m === "signup") ? "Create account" : "Log in";
    passInput.setAttribute("autocomplete", m === "signup" ? "new-password" : "current-password");
    foot.innerHTML = (m === "signup")
      ? 'Already have an account? <a href="#" id="switchToLogin">Log in</a>'
      : 'New here? <a href="#" id="switchToSignup">Create an account</a>';
    wireFootLinks();
    hideErr();
  }
  function showErr(msg){ errBox.textContent = msg; errBox.style.display = ""; }
  function hideErr(){ errBox.style.display = "none"; }

  function wireFootLinks(){
    const s = el("switchToSignup"); if(s) s.addEventListener("click", (e)=>{ e.preventDefault(); setMode("signup"); });
    const l = el("switchToLogin");  if(l) l.addEventListener("click", (e)=>{ e.preventDefault(); setMode("login"); });
  }

  el("tabLogin").addEventListener("click", ()=> setMode("login"));
  el("tabSignup").addEventListener("click", ()=> setMode("signup"));
  wireFootLinks();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideErr();
    const email = el("fEmail").value.trim();
    const password = passInput.value;
    const name = el("fName").value.trim();
    if(!email || !password){ showErr("Email and password are required."); return; }
    if(mode === "signup" && password.length < 8){ showErr("Password must be at least 8 characters."); return; }

    submit.disabled = true; const orig = submit.textContent; submit.textContent = "Please wait…";
    try{
      const url = mode === "signup" ? "/api/auth/signup" : "/api/auth/login";
      const body = mode === "signup" ? {email, password, name} : {email, password};
      const res = await fetch(url, {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body)});
      const j = await res.json().catch(()=>({}));
      if(!res.ok || !j.ok){ showErr(j.error || "Something went wrong. Please try again."); return; }
      // signup -> onboarding; login -> onboarding if no client yet, else dashboard.
      if(j.needsOnboarding) window.location.href = "/onboarding";
      else window.location.href = "/pages/dashboard.html";
    }catch(err){
      showErr("Cannot reach the server. Is the backend running?");
    }finally{
      submit.disabled = false; submit.textContent = orig;
    }
  });
})();
