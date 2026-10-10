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
