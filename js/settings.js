/* =========================================================================
   settings.js - Application Settings
   Future API:
     GET /api/settings
     PUT /api/settings
   ========================================================================= */

// Renamed to avoid clashing with common.js's global `const DEFAULT_SETTINGS`
// (a duplicate `const` in the same scope throws and would break this whole file).
const SETTINGS_DEFAULTS = {
  highConfidence: 85,
  mediumConfidence: 70,
  mappingStrategy: "Balanced",
  pageSize: 25,
  autoFlagLowConfidence: true,
  emailNotifications: false,
  reviewDigest: true,
  theme: "light",
  userName: "Rakesh Sinha",
  userEmail: "rakesh.sinha@pwc.com",
  userRole: "Migration Lead"
};

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("settings.html");
  loadIntoForm(getSettings());

  document.getElementById("saveSettingsBtn").addEventListener("click", saveForm);
  document.getElementById("resetSettingsBtn").addEventListener("click", async () => {
    const ok = await confirmDialog("Reset all settings to their default values?");
    if(!ok) return;
    saveSettings(SETTINGS_DEFAULTS);
    loadIntoForm(SETTINGS_DEFAULTS);
    applyTheme(SETTINGS_DEFAULTS.theme);
    showNotification("Settings reset to defaults.", "success");
  });
});

function loadIntoForm(s){
  document.getElementById("highConfidence").value = s.highConfidence;
  document.getElementById("mediumConfidence").value = s.mediumConfidence;
  document.getElementById("mappingStrategy").value = s.mappingStrategy;
  document.getElementById("pageSize").value = s.pageSize;
  document.getElementById("autoFlagLowConfidence").checked = !!s.autoFlagLowConfidence;
  document.getElementById("emailNotifications").checked = !!s.emailNotifications;
  document.getElementById("reviewDigest").checked = !!s.reviewDigest;
  document.getElementById("userName").value = s.userName;
  document.getElementById("userEmail").value = s.userEmail;
  document.getElementById("userRole").value = s.userRole;
  document.getElementById("theme").value = s.theme || "light";
}

function saveForm(){
  const high = +document.getElementById("highConfidence").value;
  const medium = +document.getElementById("mediumConfidence").value;

  if(medium >= high){
    showNotification("Medium confidence threshold must be lower than High confidence threshold.", "danger");
    return;
  }
  if(high < 0 || high > 100 || medium < 0 || medium > 100){
    showNotification("Confidence thresholds must be between 0 and 100.", "danger");
    return;
  }

  const newSettings = {
    highConfidence: high,
    mediumConfidence: medium,
    mappingStrategy: document.getElementById("mappingStrategy").value,
    pageSize: +document.getElementById("pageSize").value,
    autoFlagLowConfidence: document.getElementById("autoFlagLowConfidence").checked,
    emailNotifications: document.getElementById("emailNotifications").checked,
    reviewDigest: document.getElementById("reviewDigest").checked,
    theme: document.getElementById("theme").value,
    userName: document.getElementById("userName").value,
    userEmail: document.getElementById("userEmail").value,
    userRole: document.getElementById("userRole").value
  };

  saveSettings(newSettings);
  applyTheme(newSettings.theme);   // shared helper from common.js
  // keep the header toggle icon in sync with the dropdown choice
  const themeIcon = document.querySelector("#themeToggleBtn i");
  if(themeIcon) themeIcon.className = "bi " + (newSettings.theme === "dark" ? "bi-sun" : "bi-moon-stars");
  showNotification("Settings saved successfully.", "success");
}
