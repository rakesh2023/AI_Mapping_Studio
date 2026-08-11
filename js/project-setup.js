/* Future API: GET/PUT /api/projects/{id} */
document.addEventListener("DOMContentLoaded", async () => {
  await initShell("project-setup.html");
  const project = await loadProject();
  if(project){
    document.getElementById("pName").value = project.name || "";
    document.getElementById("pClient").value = project.client || "";
    document.getElementById("pDesc").value = project.description || "";
    document.getElementById("pType").value = "Data Conversion";
    document.getElementById("pDomain").value = "Insurance";
    document.getElementById("pSource").value = project.sourceApplication || "";
    document.getElementById("pTarget").value = project.targetApplication || "";
    document.getElementById("pOwner").value = project.owner || "";
    document.getElementById("pStart").value = project.startDate || "";
    document.getElementById("pEnd").value = project.targetDate || "";
  }

  document.getElementById("projectForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const updated = Object.assign({}, project, {
      name: document.getElementById("pName").value,
      client: document.getElementById("pClient").value,
      description: document.getElementById("pDesc").value,
      migrationType: document.getElementById("pType").value,
      domain: document.getElementById("pDomain").value,
      sourceApplication: document.getElementById("pSource").value,
      targetApplication: document.getElementById("pTarget").value,
      owner: document.getElementById("pOwner").value,
      startDate: document.getElementById("pStart").value,
      targetDate: document.getElementById("pEnd").value
    });
    setCurrentProject(updated);
    showNotification("Project details saved successfully.", "success");
  });

  document.getElementById("resetBtn").addEventListener("click", async () => {
    const ok = await confirmDialog("Discard unsaved changes and reload project defaults?");
    if(ok) location.reload();
  });
});
