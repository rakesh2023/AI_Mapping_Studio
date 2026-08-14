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

  loadUsers();
});
