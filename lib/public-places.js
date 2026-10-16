// Public places near a spot (parks, landmarks, cafés, shops…), from
// OpenStreetMap's free Overpass service, kept in the database for 30 days.
// Drops can only be left at one of these, and never near a school.

const { milesBetween } = require("./places");

const OVERPASS = "https://overpass-api.de/api/interpreter";
const CELL = 0.002; // about 200 m: nearby lookups share one answer
const SEARCH_METERS = 450; // around the cell's centre, so any point in it is covered
const PLACE_METERS = 150; // how close a place has to be to count as "here"
const SCHOOL_METERS = 250; // no Drops this close to a school

const KINDS = [
  ["leisure", /^(park|playground|pitch|sports_centre|stadium|garden|dog_park|skatepark|track|marina|nature_reserve|common)$/],
  ["tourism", /^(attraction|viewpoint|museum|artwork|gallery|zoo|theme_park|picnic_site|aquarium)$/],
  ["amenity", /^(cafe|restaurant|fast_food|ice_cream|library|cinema|theatre|arts_centre|marketplace|fountain|community_centre)$/],
  ["historic", /./],
  ["shop", /./],
];
const SCHOOLS = /^(school|kindergarten|childcare|college)$/;
const EMOJI = {
  park: "🌳", garden: "🌷", playground: "🛝", pitch: "🏟️", stadium: "🏟️", sports_centre: "🏟️", skatepark: "🛹", dog_park: "🐕",
  track: "🏃", marina: "⛵", nature_reserve: "🌲", common: "🌳", attraction: "⭐", viewpoint: "🌄", museum: "🏛️", artwork: "🎨",
  gallery: "🖼️", zoo: "🦒", theme_park: "🎢", picnic_site: "🧺", aquarium: "🐠", cafe: "☕", restaurant: "🍽️", fast_food: "🍔",
  ice_cream: "🍦", library: "📚", cinema: "🎬", theatre: "🎭", arts_centre: "🎨", marketplace: "🧺", fountain: "⛲",
  community_centre: "🏠", historic: "🏛️", shop: "🛍️",
};

const query = (lat, lon) => `[out:json][timeout:12];
(
  nwr(around:${SEARCH_METERS},${lat},${lon})[name][leisure~"${KINDS[0][1].source}"];
  nwr(around:${SEARCH_METERS},${lat},${lon})[name][tourism~"${KINDS[1][1].source}"];
  nwr(around:${SEARCH_METERS},${lat},${lon})[name][amenity~"${KINDS[2][1].source}"];
  nwr(around:${SEARCH_METERS},${lat},${lon})[name][historic];
  nwr(around:${SEARCH_METERS},${lat},${lon})[name][shop];
  nwr(around:${SEARCH_METERS + SCHOOL_METERS},${lat},${lon})[amenity~"${SCHOOLS.source}"];
);
out center tags 200;`;

/** Turns Overpass's answer into [{ id, name, kind, emoji, lat, lon, school }]. */
function parse(json) {
  const out = [];
  for (const el of json?.elements || []) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    const tags = el.tags || {};
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (SCHOOLS.test(tags.amenity || "")) {
      out.push({ id: `${el.type}/${el.id}`, name: tags.name || "School", kind: "school", lat, lon, school: true });
      continue;
    }
    const match = KINDS.find(([key, re]) => tags[key] && re.test(tags[key]));
    if (!match || !tags.name) continue;
    const kind = match[0] === "historic" || match[0] === "shop" ? match[0] : tags[match[0]];
    out.push({ id: `${el.type}/${el.id}`, name: String(tags.name).slice(0, 80), kind, emoji: EMOJI[kind] || "📍", lat, lon, school: false });
  }
  return out;
}

const meters = (a, b) => milesBetween(a, b) * 1609.344;

function createPublicPlaces({ store, fetch: fetchFn = globalThis.fetch, log = console }) {
  async function around(lat, lon) {
    const cLat = Math.round(lat / CELL) * CELL;
    const cLon = Math.round(lon / CELL) * CELL;
    const cell = `${cLat.toFixed(3)},${cLon.toFixed(3)}`;
    const cached = await store.cachedPlaces(cell);
    if (cached) return cached;
    const res = await fetchFn(OVERPASS, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "Radius (social.plopza.com)" },
      body: new URLSearchParams({ data: query(cLat.toFixed(5), cLon.toFixed(5)) }).toString(),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Overpass answered ${res.status}`);
    const found = parse(await res.json());
    await store.savePlaces(cell, found);
    return found;
  }

  return {
    /**
     * Public places within ~150 m of where someone is, nearest first, and
     * whether a school is too close for a Drop. `null` if we couldn't check.
     */
    async near(lat, lon) {
      let all;
      try {
        all = await around(Number(lat), Number(lon));
      } catch (err) {
        log.error("public places lookup failed", err.message || err);
        return null;
      }
      const here = { lat: Number(lat), lon: Number(lon) };
      const school = all.some((p) => p.school && meters(here, p) <= SCHOOL_METERS);
      const spots = all
        .filter((p) => !p.school && meters(here, p) <= PLACE_METERS)
        .map((p) => ({ ...p, meters: Math.round(meters(here, p)) }))
        .sort((a, b) => a.meters - b.meters)
        .slice(0, 12);
      return { spots, school };
    },
  };
}

module.exports = { createPublicPlaces, parse, meters, PLACE_METERS, SCHOOL_METERS };
