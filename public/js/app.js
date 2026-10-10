// "Use my location": asks the phone where it is, rounds it to about a mile
// right here in the browser (the server rounds it again), and sends only that.
document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!form.matches("[data-locate]") || form.dataset.located) return;
  event.preventDefault();
  const error = document.querySelector("[data-locate-error]");
  const fail = (message) => {
    if (error) {
      error.textContent = message;
      error.hidden = false;
    }
  };
  if (!navigator.geolocation) return fail("This browser can't share its location.");
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const step = 1 / 69;
      form.elements.lat.value = (Math.round(position.coords.latitude / step) * step).toFixed(3);
      form.elements.lon.value = (Math.round(position.coords.longitude / step) * step).toFixed(3);
      form.dataset.located = "yes";
      form.submit();
    },
    () => fail("Location is turned off for this site. Allow it in your browser's settings and try again."),
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60 * 1000 },
  );
});
