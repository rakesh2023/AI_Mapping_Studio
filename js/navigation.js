/* =========================================================================
   navigation.js
   Handles keyboard shortcuts and small cross-page nav utilities.
   ========================================================================= */

document.addEventListener("DOMContentLoaded", () => {
  document.addEventListener("keydown", (e) => {
    if(e.key === "/" && document.activeElement.tagName !== "INPUT"){
      const search = document.getElementById("globalSearchInput");
      if(search){ e.preventDefault(); search.focus(); }
    }
  });
});

function getQueryParam(name){
  return new URLSearchParams(window.location.search).get(name);
}
