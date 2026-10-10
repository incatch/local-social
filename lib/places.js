// Where people are, kept vague on purpose.
//
// The site never stores anyone's exact location. Coordinates from the phone
// are rounded to a grid about a mile across before they're used or saved,
// and what other people see is only the nearest town's name ("Springfield,
// MO"), never a distance or a map pin.
//
// Town names come from GeoNames (towns of 1,000+ people, via the
// all-the-cities package), looked up on our own server, so nobody's
// location is sent to another company.

// About one mile north–south. East–west it's scaled by latitude below, so
// grid squares stay roughly a mile wide everywhere.
const GRID_DEGREES = 1 / 69;

/** Rounds a location to the ~1 mile grid. Returns { lat, lon } or null if it isn't a real location. */
function roundLocation(lat, lon) {
  if ([lat, lon].some((v) => v === null || v === undefined || String(v).trim() === "")) return null;
  lat = Number(lat);
  lon = Number(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const latStep = GRID_DEGREES;
  const rLat = Math.round(lat / latStep) * latStep;
  const lonStep = GRID_DEGREES / Math.max(0.1, Math.cos((rLat * Math.PI) / 180));
  const rLon = Math.round(lon / lonStep) * lonStep;
  return { lat: Number(rLat.toFixed(4)), lon: Number(rLon.toFixed(4)) };
}

/** Miles between two points (great-circle). */
function milesBetween(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Finds the nearest town. Towns are bucketed by whole degree so a lookup
 * only checks the nearby buckets. Loaded once, on first use.
 */
function createPlaces(towns = null) {
  let buckets = null;
  const key = (lat, lon) => `${Math.floor(lat)}:${Math.floor(lon)}`;

  function load() {
    buckets = new Map();
    for (const t of towns || require("all-the-cities")) {
      const [lon, lat] = t.loc.coordinates;
      const k = key(lat, lon);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push({ name: t.name, region: t.adminCode, country: t.country, population: t.population, lat, lon });
    }
  }

  /** "Springfield, MO" (US), "Toronto, CA" elsewhere — or null if there's no town within 50 miles. */
  function nearestTown(lat, lon) {
    if (!buckets) load();
    let best = null;
    let bestMiles = 50;
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLon = -1; dLon <= 1; dLon++) {
        for (const t of buckets.get(key(lat + dLat, lon + dLon)) || []) {
          // Bigger towns win close calls, so the suburbs of a city show the city.
          const miles = milesBetween({ lat, lon }, t) - Math.min(3, Math.log10(Math.max(t.population, 1)) - 3);
          if (miles < bestMiles) {
            best = t;
            bestMiles = miles;
          }
        }
      }
    }
    if (!best) return null;
    return best.country === "US" ? `${best.name}, ${best.region}` : `${best.name}, ${best.country}`;
  }

  return { nearestTown };
}

module.exports = { roundLocation, milesBetween, createPlaces };
