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

// Selects that apply as soon as they change (the Nearby distance).
document.addEventListener("change", (event) => {
  const form = event.target.closest("form[data-autosubmit]");
  if (form) form.submit();
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
    button.textContent = liked ? "♥" : "♡";
    button.classList.toggle("liked", liked);
    button.setAttribute("aria-pressed", String(liked));
    form.querySelector("[data-like-count]").textContent = count;
  } catch {
    form.submit();
  }
});

// Carousels: light up the dot for the photo in view.
for (const carousel of document.querySelectorAll("[data-carousel]")) {
  const dots = carousel.nextElementSibling?.matches(".dots") ? [...carousel.nextElementSibling.children] : [];
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
  const input = newPost.elements.photos;
  const previews = newPost.querySelector("[data-previews]");
  const status = newPost.querySelector("[data-status]");
  const say = (text) => {
    status.textContent = text;
    status.hidden = !text;
  };
  input.addEventListener("change", () => {
    previews.replaceChildren(
      ...[...input.files].slice(0, 10).map((f) => {
        const img = document.createElement("img");
        img.src = URL.createObjectURL(f);
        img.alt = "";
        return img;
      }),
    );
    if (input.files.length > 10) say("Only the first 10 photos will be shared.");
  });
  newPost.addEventListener("submit", async (event) => {
    event.preventDefault();
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
          if (!confirm(`${err.message}\n\nShare it without a location? (It won't show on the Nearby feed.)`)) throw new Error("");
        }
      }
      const files = [...input.files].slice(0, 10);
      for (const [i, file] of files.entries()) {
        say(`Preparing photo ${i + 1} of ${files.length}…`);
        let blob = file;
        try {
          blob = await shrink(file);
        } catch {
          // Send the original; the server shrinks it.
        }
        data.append("photos", blob, `photo${i + 1}.jpg`);
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
    say("Sending snap…");
    try {
      let blob = file;
      try {
        blob = await shrink(file);
      } catch {
        // Send the original; the server shrinks it.
      }
      const data = new FormData();
      data.append("photo", blob, "snap.jpg");
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
