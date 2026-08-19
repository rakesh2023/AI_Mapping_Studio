/* =========================================================================
   admin.js - User Administration (pages/admin.html). Admin-only.
   Lists accounts and lets an admin create standard users and delete users.
   Deleting a user permanently removes all their data (clients, mappings,
   connections, history, usage log). The server enforces admin access; this
   page also redirects non-admins as defense-in-depth.
   ========================================================================= */
document.addEventListener("DOMContentLoaded", async () => {
  await initShell("admin.html");

  // Defense-in-depth: only admins should ever render this page (server also gates it).
  if(!AUTH || !AUTH.user || !AUTH.user.isAdmin){ window.location.href = "dashboard.html"; return; }

  const body = document.getElementById("usersBody");
  const countEl = document.getElementById("userCount");
  const errBox = document.getElementById("createErr");
  const showErr = (m) => { errBox.textContent = m; errBox.style.display = ""; };
  const hideErr = () => { errBox.style.display = "none"; };

  const fmt = (iso) => {
    if(!iso) return "—";
    try{ return new Date(iso).toLocaleString(); }catch(e){ return iso; }
  };

  async function loadUsers(){
    try{
      const res = await fetch("/api/admin/users", {headers:{"Accept":"application/json"}});
      const j = await res.json().catch(()=>({}));
      if(!res.ok || !j.ok){ body.innerHTML = '<tr><td colspan="7" class="text-danger text-xs">' + escapeHtml(j.error || "Could not load users.") + '</td></tr>'; return; }
      renderUsers(j.users || []);
    }catch(e){
      body.innerHTML = '<tr><td colspan="7" class="text-danger text-xs">Cannot reach the server.</td></tr>';
    }
  }

  function renderUsers(users){
    countEl.textContent = "· " + users.length + " account" + (users.length === 1 ? "" : "s");
    if(!users.length){ body.innerHTML = '<tr><td colspan="7" class="text-muted-2 text-xs">No users.</td></tr>'; return; }
    const me = AUTH.user.id;
    body.innerHTML = users.map(u => {
      const roleCell = u.isAdmin
        ? '<span class="badge-soft badge-high">Admin</span>'
        : escapeHtml(u.role || "User");
      // Admins and your own account cannot be deleted here.
      const canDelete = !u.isAdmin && u.id !== me;
      const action = canDelete
        ? '<button class="btn btn-sm btn-outline-soft" data-del="' + u.id + '" data-email="' + escapeHtml(u.email) + '" title="Delete user"><i class="bi bi-trash"></i> Delete</button>'
        : '<span class="text-muted-2 text-xs">' + (u.id === me ? "You" : "Protected") + '</span>';
      return '<tr>' +
        '<td class="mono">' + escapeHtml(u.email) + '</td>' +
        '<td>' + escapeHtml(u.name || "—") + '</td>' +
        '<td>' + roleCell + '</td>' +
        '<td>' + (u.clientCount || 0) + '</td>' +
        '<td class="text-xs">' + escapeHtml(fmt(u.createdAt)) + '</td>' +
        '<td class="text-xs">' + escapeHtml(fmt(u.lastLoginAt)) + '</td>' +
        '<td class="text-end">' + action + '</td>' +
      '</tr>';
    }).join("");

    body.querySelectorAll("[data-del]").forEach(btn => btn.addEventListener("click", () => deleteUser(btn.dataset.del, btn.dataset.email)));
  }

  async function deleteUser(id, email){
    const ok = await confirmDialog(
      "Permanently delete " + email + "?\n\nThis removes the account and ALL of its data — clients, mappings, "
      + "connections, history and usage log. This cannot be undone.", "Delete user");
    if(!ok) return;
    try{
      const res = await fetch("/api/admin/users/" + encodeURIComponent(id), {method:"DELETE"});
      const j = await res.json().catch(()=>({}));
      if(!res.ok || !j.ok){ showNotification(j.error || "Delete failed.", "danger"); return; }
      showNotification("User deleted and all their data removed.", "success");
      loadUsers();
    }catch(e){ showNotification("Cannot reach the server.", "danger"); }
  }

  document.getElementById("createForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    hideErr();
    const email = document.getElementById("nEmail").value.trim();
    const name = document.getElementById("nName").value.trim();
    const password = document.getElementById("nPass").value;
    if(!email || !password){ showErr("Email and password are required."); return; }
    if(password.length < 8){ showErr("Password must be at least 8 characters."); return; }
    const btn = document.getElementById("createBtn");
    btn.disabled = true;
    try{
      const res = await fetch("/api/admin/users", {method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({email, name, password})});
      const j = await res.json().catch(()=>({}));
      if(!res.ok || !j.ok){ showErr(j.error || "Could not create the user."); return; }
      showNotification("User " + email + " created.", "success");
      document.getElementById("createForm").reset();
      loadUsers();
    }catch(e){ showErr("Cannot reach the server."); }
    finally{ btn.disabled = false; }
  });

  // ---------- Feedback (suggestions / bugs) ----------
  const fbBody = document.getElementById("feedbackBody");
  const fbCount = document.getElementById("fbCount");
  const fbFilterStatus = document.getElementById("fbFilterStatus");
  const fbFilterType = document.getElementById("fbFilterType");
  let FEEDBACK = [];
  const STATUS_LABEL = {new:"New", accepted:"Accepted", in_development:"In Development", done:"Done", declined:"Declined"};
  const STATUS_COLOR = {new:"#3b82f6", accepted:"#14b8a6", in_development:"#f59e0b", done:"#22c55e", declined:"#9ca3af"};
  const TYPE_BADGE = {bug:"badge-low", suggestion:"badge-blue", other:"badge-gray"};
  const cap = (s) => (s || "").charAt(0).toUpperCase() + (s || "").slice(1);
  const shortUA = (ua) => ua && ua.length > 60 ? ua.slice(0, 60) + "…" : (ua || "");

  async function loadFeedback(){
    try{
      const res = await fetch("/api/admin/feedback", {headers:{"Accept":"application/json"}});
      const j = await res.json().catch(()=>({}));
      if(!res.ok || !j.ok){ fbBody.innerHTML = '<tr><td colspan="6" class="text-danger text-xs">' + escapeHtml(j.error || "Could not load feedback.") + '</td></tr>'; return; }
      FEEDBACK = j.feedback || [];
      renderFeedback();
    }catch(e){ fbBody.innerHTML = '<tr><td colspan="6" class="text-danger text-xs">Cannot reach the server.</td></tr>'; }
  }

  function renderFeedback(){
    const fs = fbFilterStatus.value, ft = fbFilterType.value;
    const rows = FEEDBACK.filter(f => (!fs || f.status === fs) && (!ft || f.type === ft));
    fbCount.textContent = "· " + rows.length + (rows.length === FEEDBACK.length ? "" : " of " + FEEDBACK.length);
    if(!rows.length){ fbBody.innerHTML = '<tr><td colspan="6" class="text-muted-2 text-xs">No feedback.</td></tr>'; return; }
    fbBody.innerHTML = rows.map(f => {
      const typeCls = TYPE_BADGE[f.type] || "badge-gray";
      const opts = Object.keys(STATUS_LABEL).map(s => '<option value="' + s + '"' + (s === f.status ? " selected" : "") + '>' + STATUS_LABEL[s] + '</option>').join("");
      const from = f.submitterEmail ? escapeHtml(f.submitterEmail) : "—";
      const pageBrowser = escapeHtml(f.page || "—") +
        (f.userAgent ? '<div class="text-muted-2" style="font-size:.68rem;">' + escapeHtml(shortUA(f.userAgent)) + '</div>' : '');
      return '<tr>' +
        '<td><span class="badge-soft ' + typeCls + '">' + escapeHtml(cap(f.type)) + '</span></td>' +
        '<td style="max-width:360px;white-space:pre-wrap;">' + escapeHtml(f.message) + '</td>' +
        '<td class="text-xs">' + from + '</td>' +
        '<td class="text-xs mono">' + pageBrowser + '</td>' +
        '<td class="text-xs">' + escapeHtml(fmt(f.createdAt)) + '</td>' +
        '<td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle;background:' + (STATUS_COLOR[f.status] || "#9ca3af") + ';"></span>' +
          '<select class="form-select form-select-sm d-inline-block" style="width:auto;" data-fb="' + f.id + '">' + opts + '</select></td>' +
      '</tr>';
    }).join("");
    fbBody.querySelectorAll("[data-fb]").forEach(sel => sel.addEventListener("change", () => changeFbStatus(sel.dataset.fb, sel.value)));
  }

  async function changeFbStatus(id, status){
    try{
      const res = await fetch("/api/admin/feedback/" + encodeURIComponent(id) + "/status", {method:"POST",
        headers:{"Content-Type":"application/json"}, body: JSON.stringify({status})});
      const j = await res.json().catch(()=>({}));
      if(!res.ok || !j.ok){ showNotification(j.error || "Could not update status.", "danger"); return; }
      const item = FEEDBACK.find(f => String(f.id) === String(id)); if(item) item.status = status;
      renderFeedback();
      showNotification("Status updated.", "success", 1500);
    }catch(e){ showNotification("Cannot reach the server.", "danger"); }
  }

  if(fbFilterStatus) fbFilterStatus.addEventListener("change", renderFeedback);
  if(fbFilterType) fbFilterType.addEventListener("change", renderFeedback);

  loadUsers();
  loadFeedback();
});
