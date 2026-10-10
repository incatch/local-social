// Small helpers for the pages. Everything works without them (plain
// forms), they just make it nicer on a phone.

const GRID = 1 / 69; // about a mile, as on the server

/** The phone's location, rounded to about a mile here in the browser. */
function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("This browser can't share its location."));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: (Math.round(p.coords.latitude / GRID) * GRID).toFixed(3), lon: (Math.round(p.coords.longitude / GRID) * GRID).toFixed(3) }),
      () => reject(new Error("Location is turned off for this site. Allow it in your browser's settings and try again.")),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60 * 1000 },
    );
  });
}

// "Use my location" buttons (profile area, Nearby feed).
document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!form.matches("[data-locate]") || form.dataset.located) return;
  event.preventDefault();
  const error = document.querySelector("[data-locate-error]");
  locate().then(
    ({ lat, lon }) => {
      form.elements.lat.value = lat;
      form.elements.lon.value = lon;
      form.dataset.located = "yes";
      form.submit();
    },
    (err) => {
      if (error) {
        error.textContent = err.message;
        error.hidden = false;
      }
    },
  );
});

// Likes without reloading the page.
document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!form.matches("[data-like]")) return;
  event.preventDefault();
  try {
    const res = await fetch(form.action, { method: "POST", body: new URLSearchParams(new FormData(form)), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error();
    const { liked, count } = await res.json();
    const button = form.querySelector("button");
    button.querySelector("svg").setAttribute("fill", liked ? "currentColor" : "none");
    button.classList.toggle("liked", liked);
    button.setAttribute("aria-pressed", String(liked));
    form.querySelector("[data-like-count]").textContent = count;
  } catch {
    form.submit();
  }
});

// Carousels: light up the dot for the photo in view.
for (const carousel of document.querySelectorAll("[data-carousel]")) {
  const dots = [...(carousel.parentElement.querySelector(".dots")?.children || [])];
  const update = () => {
    const i = Math.round(carousel.scrollLeft / carousel.clientWidth);
    dots.forEach((d, j) => d.classList.toggle("on", i === j));
  };
  carousel.addEventListener("scroll", update, { passive: true });
  update();
}

// New posts: shrink photos on the phone first (much faster uploads; it
// also drops their hidden location data, which the server removes again),
// and add the rounded location if wanted.
const MAX_SIDE = 2048;
async function shrink(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("resize failed"))), "image/jpeg", 0.88));
}

const newPost = document.querySelector("[data-new-post]");
if (newPost) {
  const MAX = 10;
  const input = newPost.elements.photos;
  const picker = newPost.querySelector("[data-picker]");
  const tiles = newPost.querySelector("[data-previews]");
  const addLabel = newPost.querySelector("[data-add-label]");
  const status = newPost.querySelector("[data-status]");
  const say = (text) => {
    status.textContent = text;
    status.hidden = !text;
  };
  // The photos picked so far: each pick adds to them, and each can be removed.
  let chosen = [];
  input.required = false;
  const show = () => {
    tiles.replaceChildren(
      ...chosen.map((file, i) => {
        const tile = document.createElement("div");
        tile.className = "tile";
        const img = document.createElement("img");
        img.src = file.preview;
        img.alt = `Photo ${i + 1}`;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove photo ${i + 1}`);
        remove.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg>';
        remove.addEventListener("click", () => {
          URL.revokeObjectURL(file.preview);
          chosen.splice(i, 1);
          show();
        });
        tile.append(img, remove);
        if (i === 0 && chosen.length > 1) {
          const first = document.createElement("span");
          first.className = "first";
          first.textContent = "Cover";
          tile.append(first);
        }
        return tile;
      }),
    );
    picker.classList.toggle("has-photos", chosen.length > 0);
    picker.querySelector(".add-tile").hidden = chosen.length >= MAX;
    addLabel.textContent = chosen.length ? "Add more" : "Add photos";
  };
  input.addEventListener("change", () => {
    const room = MAX - chosen.length;
    const picked = [...input.files];
    for (const file of picked.slice(0, room)) {
      file.preview = URL.createObjectURL(file);
      chosen.push(file);
    }
    say(picked.length > room ? `Up to ${MAX} photos per post, so only the first ${room} were added.` : "");
    input.value = "";
    show();
  });
  newPost.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!chosen.length) return say("Add at least one photo first.");
    const button = newPost.querySelector("[data-submit]");
    button.disabled = true;
    try {
      const data = new FormData();
      data.append("caption", newPost.elements.caption.value);
      if (newPost.elements.with_location.checked) {
        say("Getting your location…");
        try {
          const { lat, lon } = await locate();
          data.append("with_location", "on");
          data.append("lat", lat);
          data.append("lon", lon);
        } catch (err) {
          if (!confirm(`${err.message}\n\nShare it without a location? (It won't show on Nearby.)`)) throw new Error("");
        }
      }
      for (const [i, file] of chosen.entries()) {
        say(`Preparing photo ${i + 1} of ${chosen.length}…`);
        let blob = file;
        try {
          blob = await shrink(file);
        } catch {
          // Send the original; the server shrinks it.
        }
        data.append("photos", blob, `photo${i + 1}.jpg`);
        // Shrinking drops the camera's record of when and where it was taken
        // (and any "made with AI" label), so send the start of the original
        // too; the server reads those and throws them away.
        if (blob !== file) data.append(`head${i}`, file.slice(0, 512 * 1024), `head${i}`);
      }
      say("Sharing…");
      const res = await fetch(newPost.action, { method: "POST", body: data, headers: { accept: "application/json" } });
      const out = await res.json().catch(() => ({ error: "Something went wrong. Please try again." }));
      if (!res.ok) throw new Error(out.error);
      location.href = out.location;
    } catch (err) {
      say(err.message);
      button.disabled = false;
    }
  });
}

// Profile photo: upload as soon as one is picked.
document.addEventListener("change", (event) => {
  const form = event.target.closest("form[data-photo-form]");
  if (form && event.target.files?.length) form.submit();
});

// Chats: start at the newest message, and check for new ones every few
// seconds while the page is open.
const chat = document.querySelector("[data-chat]");
if (chat) {
  const toBottom = () => window.scrollTo(0, document.body.scrollHeight);
  toBottom();
  let busy = false;
  setInterval(async () => {
    if (busy || document.hidden) return;
    busy = true;
    try {
      const res = await fetch(chat.dataset.chat, { headers: { accept: "text/html" } });
      if (res.ok) {
        const html = await res.text();
        if (html.trim() !== chat.innerHTML.trim()) {
          const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 120;
          chat.innerHTML = html;
          if (nearBottom) toBottom();
        }
      }
    } catch {
      // Try again next time.
    }
    busy = false;
  }, 4000);
}

// Snaps: send as soon as a photo is picked (shrunk on the phone first).
const snapForm = document.querySelector("[data-snap]");
if (snapForm) {
  const input = snapForm.elements.photo;
  const status = snapForm.querySelector("[data-status]");
  const say = (text) => {
    status.textContent = text;
    status.hidden = !text;
  };
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    say("Sending photo…");
    try {
      let blob = file;
      try {
        blob = await shrink(file);
      } catch {
        // Send the original; the server shrinks it.
      }
      const data = new FormData();
      data.append("photo", blob, "photo.jpg");
      const res = await fetch(snapForm.action, { method: "POST", body: data, headers: { accept: "application/json" } });
      const out = await res.json().catch(() => ({ error: "Something went wrong. Please try again." }));
      if (!res.ok) throw new Error(out.error);
      location.href = out.location;
    } catch (err) {
      say(err.message);
      input.value = "";
    }
  });
}

// Moved? If location is already allowed for the site (so no permission
// pop-up), check now and then, quietly. If they're far from their saved
// spot, offer to update it with a small card they can wave away.
const CHECK_EVERY = 30 * 60 * 1000;
const SNOOZE = 24 * 60 * 60 * 1000;
const remember = {
  get: (k) => {
    try {
      return Number(localStorage.getItem(k) || 0);
    } catch {
      return 0;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, String(v));
    } catch {
      // Private browsing: just check each visit.
    }
  },
};
async function checkMoved() {
  const token = document.body.dataset.token;
  if (!token || !navigator.permissions || !navigator.geolocation) return;
  const now = Date.now();
  if (now - remember.get("radius.checked") < CHECK_EVERY || now < remember.get("radius.snooze")) return;
  try {
    const permission = await navigator.permissions.query({ name: "geolocation" });
    if (permission.state !== "granted") return;
  } catch {
    return;
  }
  remember.set("radius.checked", now);
  let spot;
  try {
    spot = await locate();
  } catch {
    return;
  }
  const res = await fetch(`/location/check?lat=${spot.lat}&lon=${spot.lon}`, { headers: { accept: "application/json" } });
  if (!res.ok) return;
  const { moved, town } = await res.json();
  if (!moved) return;

  const card = document.createElement("div");
  card.className = "moved";
  card.setAttribute("role", "status");
  card.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-6-5.6-6-10.5a6 6 0 0 1 12 0C18 15.4 12 21 12 21z"/><circle cx="12" cy="10.5" r="2.2"/></svg><span></span><button type="button" class="small" data-yes>Update</button><button type="button" class="small link" data-no>Not now</button>';
  card.querySelector("span").textContent = town ? `Looks like you're near ${town} now.` : "Looks like you've moved.";
  document.body.append(card);
  card.querySelector("[data-no]").addEventListener("click", () => {
    remember.set("radius.snooze", Date.now() + SNOOZE);
    card.remove();
  });
  card.querySelector("[data-yes]").addEventListener("click", async () => {
    const body = new URLSearchParams({ _token: token, lat: spot.lat, lon: spot.lon });
    const done = await fetch("/location/update", { method: "POST", body, headers: { accept: "application/json" } }).catch(() => null);
    card.remove();
    if (done?.ok && location.pathname === "/") location.reload();
  });
}
checkMoved().catch(() => {});

// Joining (teen mode): show the parent's-email box for younger teens as soon
// as the birthday is typed, and, where teen sign-ups are limited to some
// states, get the (rounded) location when a teen taps Join.
const welcome = document.querySelector("form[data-welcome]");
if (welcome) {
  const consentUnder = Number(welcome.dataset.consentUnder || 0);
  const parentBox = welcome.querySelector("[data-parent]");
  const ageFrom = (value) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
    if (!m) return null;
    const now = new Date();
    let age = now.getFullYear() - Number(m[1]);
    if (now.getMonth() + 1 < Number(m[2]) || (now.getMonth() + 1 === Number(m[2]) && now.getDate() < Number(m[3]))) age -= 1;
    return age;
  };
  welcome.elements.birth_date.addEventListener("change", () => {
    const age = ageFrom(welcome.elements.birth_date.value);
    if (parentBox) {
      const show = age !== null && age < consentUnder;
      parentBox.hidden = !show;
      welcome.elements.parent_email.required = show;
    }
  });
  welcome.addEventListener("submit", (event) => {
    const age = ageFrom(welcome.elements.birth_date.value);
    if (!welcome.dataset.teenLocation || age === null || age >= 18 || welcome.dataset.located) return;
    event.preventDefault();
    locate().then(
      ({ lat, lon }) => {
        welcome.elements.lat.value = lat;
        welcome.elements.lon.value = lon;
        welcome.dataset.located = "yes";
        welcome.submit();
      },
      () => welcome.submit(), // the server explains what's needed
    );
  });
}

// Plans: send the time with the phone's own time zone.
const signalForm = document.querySelector("form[data-signal]");
if (signalForm && signalForm.elements.plan_at) {
  signalForm.addEventListener("submit", () => {
    const v = signalForm.elements.plan_at.value;
    if (v) signalForm.elements.plan_at_iso.value = new Date(v).toISOString();
  });
}

// "I'm in" without reloading.
document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!form.matches("[data-join]")) return;
  event.preventDefault();
  try {
    const res = await fetch(form.action, { method: "POST", body: new URLSearchParams(new FormData(form)), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error();
    const { joined, count } = await res.json();
    const button = form.querySelector("button");
    button.textContent = joined ? "✓ You're in" : "I'm in";
    button.classList.toggle("secondary", joined);
    const counter = form.parentElement.querySelector("[data-join-count]");
    if (counter) counter.textContent = `${count} in`;
    if (joined && navigator.vibrate) navigator.vibrate(12);
  } catch {
    form.submit();
  }
});

// Visiting another town: suggestions as you type.
const townSearch = document.querySelector("[data-town-search]");
if (townSearch) {
  let timer;
  townSearch.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (townSearch.value.trim().length < 2) return;
      try {
        const res = await fetch(`/places/search?q=${encodeURIComponent(townSearch.value)}`, { headers: { accept: "application/json" } });
        const towns = await res.json();
        const list = document.getElementById("town-list");
        list.replaceChildren(...towns.map((t) => Object.assign(document.createElement("option"), { value: t })));
      } catch {
        // Typing still works without suggestions.
      }
    }, 180);
  });
  // Picking a suggestion goes straight there.
  townSearch.addEventListener("change", () => {
    if ([...document.querySelectorAll("#town-list option")].some((o) => o.value === townSearch.value)) townSearch.form.submit();
  });
}

// Phone notifications: turn on, test, turn off (the card in Settings and the first look).
const pushCardEl = document.querySelector("[data-push]");
if (pushCardEl) {
  const $ = (sel) => pushCardEl.querySelector(sel);
  const status = $("[data-push-status]");
  const on = $("[data-push-on]");
  const off = $("[data-push-off]");
  const tryIt = $("[data-push-test]");
  const ios = $("[data-push-ios]");
  const token = document.body.dataset.token;
  const post = (path, fields) => fetch(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ _token: token, ...fields }) });
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const iPhone = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const show = (state, text) => {
    on.hidden = state !== "off";
    off.hidden = state !== "on";
    tryIt.hidden = state !== "on";
    if (text) status.textContent = text;
  };
  const keyBytes = (b64) => {
    const raw = atob((b64 + "===".slice((b64.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };
  const subscription = async () => {
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    return { reg, sub: await reg.pushManager.getSubscription() };
  };
  (async () => {
    if (iPhone && !standalone) {
      on.hidden = true;
      ios.hidden = false;
      return;
    }
    if (!supported) {
      show("none", "This browser can't show notifications. Try Chrome, or Safari on an iPhone added to the Home Screen.");
      return;
    }
    if (Notification.permission === "denied") {
      show("none", "Notifications are blocked for Radius. Allow them in your browser or phone settings, then come back.");
      return;
    }
    const { sub } = await subscription().catch(() => ({}));
    if (sub && Notification.permission === "granted") {
      await post("/push/subscribe", { endpoint: sub.endpoint, p256dh: sub.toJSON().keys.p256dh, auth: sub.toJSON().keys.auth }).catch(() => {});
      show("on", "Notifications are on for this device. 👍");
    } else show("off");
  })();
  on.addEventListener("click", async () => {
    on.disabled = true;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        show(permission === "denied" ? "none" : "off", "No problem. You can turn them on any time here.");
        return;
      }
      const { reg } = await subscription();
      const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(pushCardEl.dataset.push) }));
      const keys = sub.toJSON().keys;
      const res = await post("/push/subscribe", { endpoint: sub.endpoint, p256dh: keys.p256dh, auth: keys.auth });
      if (!res.ok) throw new Error("save failed");
      if (navigator.vibrate) navigator.vibrate(12);
      show("on", "Notifications are on for this device. 👍");
    } catch {
      status.textContent = "That didn't work. Please try again.";
    } finally {
      on.disabled = false;
    }
  });
  tryIt.addEventListener("click", async () => {
    tryIt.disabled = true;
    await post("/push/test", {}).catch(() => {});
    setTimeout(() => (tryIt.disabled = false), 3000);
  });
  off.addEventListener("click", async () => {
    const { sub } = await subscription().catch(() => ({}));
    if (sub) {
      await post("/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
    show("off", "Notifications are off for this device.");
  });
}

// Squad chat: send without reloading, and check for new messages every few seconds.
const squadChat = document.querySelector("[data-squad-chat]");
if (squadChat) {
  const id = squadChat.dataset.squadChat;
  const lastId = () => Number([...squadChat.querySelectorAll("li[data-id]")].pop()?.dataset.id || 0);
  const add = (m) => {
    if (squadChat.querySelector(`li[data-id="${m.id}"]`)) return;
    squadChat.querySelector(".empty")?.remove();
    const li = document.createElement("li");
    li.dataset.id = m.id;
    if (m.mine) li.className = "mine";
    for (const [cls, text] of [["who", m.name], ["text", m.body], ["when", "just now"]]) {
      const span = document.createElement("span");
      span.className = cls;
      span.textContent = text;
      li.append(span);
    }
    squadChat.append(li);
    squadChat.scrollTop = squadChat.scrollHeight;
  };
  const check = async () => {
    try {
      const res = await fetch(`/squads/${id}/messages?after=${lastId()}`);
      if (res.ok) (await res.json()).forEach(add);
    } catch {
      // Try again next time.
    }
  };
  squadChat.scrollTop = squadChat.scrollHeight;
  setInterval(() => document.visibilityState === "visible" && check(), 4000);
  const form = document.querySelector("[data-squad-say]");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const box = form.elements.body;
    if (!box.value.trim()) return;
    try {
      const res = await fetch(form.action, { method: "POST", body: new URLSearchParams(new FormData(form)), headers: { accept: "application/json" } });
      if (!res.ok) throw new Error();
      box.value = "";
      await check();
    } catch {
      form.submit();
    }
  });
}

// Finding people: results update as you type.
const peopleSearch = document.querySelector("[data-people-search]");
if (peopleSearch) {
  const results = document.querySelector("[data-people-results]");
  let timer;
  let latest = 0;
  peopleSearch.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = peopleSearch.value.trim();
      const ask = ++latest;
      try {
        const res = await fetch(`/search?partial=1&q=${encodeURIComponent(q)}`);
        if (!res.ok || ask !== latest) return;
        results.innerHTML = await res.text();
        history.replaceState(null, "", q ? `/search?q=${encodeURIComponent(q)}` : "/search");
      } catch {
        // Pressing search still works.
      }
    }, 200);
  });
}

// ── Shareable pictures (the daily recap, invite cards), drawn on the phone ──
const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
/** Draws `img` to fill the box (cropping the middle), with rounded corners. */
function cover(ctx, img, x, y, w, h, r = 36) {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale;
  const sh = h / scale;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.clip();
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
  ctx.restore();
}
function rings(ctx, cx, cy, s) {
  ctx.lineWidth = s * 0.06;
  ctx.strokeStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx, cy, s * 0.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,.6)";
  ctx.beginPath();
  ctx.arc(cx, cy, s * 0.3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx, cy, s * 0.12, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f9a53c";
  ctx.beginPath();
  ctx.arc(cx + s * 0.38, cy - s * 0.33, s * 0.08, 0, Math.PI * 2);
  ctx.fill();
}
function background(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, "#5b5fe0");
  g.addColorStop(1, "#1c1b33");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}
async function drawCard(spec) {
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1920;
  const ctx = canvas.getContext("2d");
  background(ctx, 1080, 1920);
  ctx.textAlign = "center";
  ctx.fillStyle = "#ffffff";
  if (spec.kind === "recap") {
    ctx.font = "800 84px Jakarta, sans-serif";
    ctx.fillText(spec.title, 540, 210);
    ctx.font = "600 44px Jakarta, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,.75)";
    ctx.fillText(spec.date, 540, 280);
    const imgs = (await Promise.allSettled(spec.photos.map(loadImage))).filter((r) => r.status === "fulfilled").map((r) => r.value);
    // A collage: one big photo on top, the rest in a grid below.
    const gap = 20;
    if (imgs[0]) cover(ctx, imgs[0], 60, 340, 960, 760);
    const rest = imgs.slice(1, 5);
    const cols = rest.length > 2 ? 2 : rest.length;
    rest.forEach((img, i) => {
      const w = (960 - gap * (cols - 1)) / cols;
      const rowH = rest.length > 2 ? 270 : 560;
      cover(ctx, img, 60 + (i % cols) * (w + gap), 1100 + gap + Math.floor(i / cols) * (rowH + gap), w, rowH);
    });
  } else {
    rings(ctx, 540, 380, 220);
    ctx.font = "600 52px Jakarta, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,.8)";
    ctx.fillText(`${spec.name} invited you to`, 540, 620);
    ctx.font = "800 150px Jakarta, sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(spec.site, 540, 780);
    ctx.font = "700 52px Jakarta, sans-serif";
    ctx.fillText(`${spec.town}${spec.people > 1 ? ` · ${spec.people} people nearby` : ""}`, 540, 880);
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.roundRect(290, 970, 500, 500, 40);
    ctx.fill();
    const qr = await loadImage(spec.qr);
    ctx.drawImage(qr, 320, 1000, 440, 440);
    ctx.font = "600 44px Jakarta, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,.85)";
    ctx.fillText(spec.tagline, 540, 1580);
    ctx.font = "500 36px Jakarta, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,.6)";
    ctx.fillText(spec.link.replace(/^https?:\/\//, ""), 540, 1650);
  }
  // The mark at the bottom.
  rings(ctx, 470, 1820, 60);
  ctx.textAlign = "left";
  ctx.font = "800 52px Jakarta, sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(spec.site, 515, 1838);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}
function shareStatus(text) {
  const el = document.querySelector("[data-share-status]");
  if (el) {
    el.textContent = text;
    el.hidden = !text;
  }
}
document.addEventListener("click", async (event) => {
  const cardButton = event.target.closest("[data-share-card]");
  const linkButton = event.target.closest("[data-share-link]");
  if (cardButton) {
    cardButton.disabled = true;
    shareStatus("Making your picture…");
    try {
      const spec = JSON.parse(cardButton.dataset.shareCard);
      const blob = await drawCard(spec);
      const file = new File([blob], spec.kind === "recap" ? "today.png" : "invite.png", { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: spec.title || spec.site });
        shareStatus("");
      } else {
        // No sharing here (a computer): save it instead.
        const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: file.name });
        a.click();
        shareStatus("Saved. Post it anywhere!");
      }
    } catch (err) {
      shareStatus(err && err.name === "AbortError" ? "" : "Couldn't make the picture. Please try again.");
    }
    cardButton.disabled = false;
  } else if (linkButton) {
    const url = linkButton.dataset.shareLink;
    try {
      if (navigator.share) await navigator.share({ text: linkButton.dataset.shareText, url });
      else {
        await navigator.clipboard.writeText(url);
        shareStatus("Link copied. Paste it anywhere!");
      }
    } catch {
      // Closed the share sheet.
    }
  }
});
