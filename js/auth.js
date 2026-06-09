/* AI三千问 — Auth (cookie版) */

function getCookie(name) {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[2]) : null;
}

function setCookie(name, value, maxAge) {
  document.cookie = name + '=' + encodeURIComponent(value) + '; path=/; max-age=' + (maxAge || 86400);
}

function removeCookie(name) {
  document.cookie = name + '=; path=/; max-age=0';
}

const AUTH = {
  isLoggedIn() { return !!getCookie('sqw_username'); },
  getToken() { return getCookie('sqw_token'); },
  getUsername() { return getCookie('sqw_username'); },
};
