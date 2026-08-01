const $ = (sel) => document.querySelector(sel);

const API = "/api";
let token = localStorage.getItem("cf_token");

const loginForm = $("#login-form");
const registerForm = $("#register-form");
const loginError = $("#login-error");
const registerError = $("#register-error");

$("#show-register").addEventListener("click", (e) => {
  e.preventDefault();
  loginForm.classList.add("hidden");
  registerForm.classList.remove("hidden");
  registerError.textContent = "";
});

$("#show-login").addEventListener("click", (e) => {
  e.preventDefault();
  registerForm.classList.add("hidden");
  loginForm.classList.remove("hidden");
  loginError.textContent = "";
});

async function post(url, body) {
  const res = await fetch(API + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Terjadi kesalahan.");
  return data;
}

function setBusy(btn, busy) {
  btn.disabled = busy;
  btn.textContent = busy ? "Mohon tunggu..." : btn.dataset.label || btn.textContent;
}

function gotoChat() {
  window.location.href = "chat.html";
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = loginForm.querySelector("button");
  setBusy(btn, true);
  try {
    const data = await post("/login", {
      username: $("#login-username").value.trim(),
      password: $("#login-password").value,
    });
    localStorage.setItem("cf_token", data.token);
    gotoChat();
  } catch (err) {
    loginError.textContent = err.message;
  } finally {
    setBusy(btn, false);
  }
});

registerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = registerForm.querySelector("button");
  const p1 = $("#reg-password").value;
  const p2 = $("#reg-password2").value;
  registerError.textContent = "";
  if (p1 !== p2) {
    registerError.textContent = "Password tidak sama.";
    return;
  }
  setBusy(btn, true);
  try {
    const data = await post("/register", {
      username: $("#reg-username").value.trim(),
      password: p1,
    });
    localStorage.setItem("cf_token", data.token);
    gotoChat();
  } catch (err) {
    registerError.textContent = err.message;
  } finally {
    setBusy(btn, false);
  }
});

(async () => {
  if (!token) return;
  try {
    const res = await fetch(API + "/me", {
      headers: { Authorization: "Bearer " + token },
    });
    if (res.ok) gotoChat();
  } catch (_) {}
})();
