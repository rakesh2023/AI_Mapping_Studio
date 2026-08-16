/* =========================================================================
   navigation.js
   Handles keyboard shortcuts and small cross-page nav utilities.
   ========================================================================= */

function getQueryParam(name){
  return new URLSearchParams(window.location.search).get(name);
}
