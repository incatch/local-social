// Keeping politics off the Nearby feed.
//
// A post is political if its caption, or text in its photos, uses a word
// or phrase from the list (Admin → Nearby rules), or if its photos show a
// political figure: someone Rekognition recognises whose Wikidata entry
// says they're a politician, hold political office or belong to a party,
// or a name the owner added. Political posts still show on profiles and the
// Following feed; they just don't appear on Nearby.

// The starting list (the owner can change it in Admin).
const DEFAULT_WORDS = [
  "democrat", "democrats", "democratic party", "republican", "republicans", "gop", "maga", "make america great again",
  "liberals", "conservatives", "libtard", "leftist", "right wing", "left wing",
  "trump", "biden", "kamala", "obama", "jd vance", "pelosi", "desantis", "newsom", "aoc",
  "vote for", "vote blue", "vote red", "election", "elections", "ballot", "midterms", "primary election", "campaign rally",
  "senator", "congressman", "congresswoman", "congress", "senate", "governor", "white house", "supreme court",
  "impeach", "impeachment", "socialism", "socialist", "communism", "communist", "fascism", "fascist", "antifa",
  "abortion", "pro-life", "pro-choice", "roe v wade", "gun control", "second amendment", "immigration", "border wall",
  "build the wall", "no kings", "political", "politics", "politician",
];
const POLITICIAN = "Q82955"; // Wikidata: occupation "politician"

/** The word list in use: the owner's, or the starting one. */
function wordList(settings) {
  const own = String(settings.political_words || "")
    .split(/\n|,/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  return own.length ? own : DEFAULT_WORDS;
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The first listed word or phrase in `text` (whole words only), or null. */
function politicalWord(text, words) {
  const t = String(text || "").toLowerCase().replace(/[#@]/g, " ");
  for (const w of words) {
    if (new RegExp(`(^|[^a-z0-9])${escape(w)}($|[^a-z0-9])`, "i").test(t)) return w;
  }
  return null;
}

function createPolitics({ store, fetch = globalThis.fetch, log = console }) {
  /** Is this recognised person a political figure? (Cached per Wikidata id.) */
  async function isPolitical(person, extraNames) {
    if (extraNames.includes(person.name.toLowerCase())) return true;
    if (!person.wikidataId) return false;
    const known = await store.politicalPerson(person.wikidataId);
    if (known) return known.political;
    try {
      const res = await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${person.wikidataId}.json`, {
        headers: { "user-agent": "Radius/1.0 (https://social.plopza.com)" },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`wikidata ${res.status}`);
      const claims = (await res.json()).entities?.[person.wikidataId]?.claims || {};
      const occupations = (claims.P106 || []).map((c) => c.mainsnak?.datavalue?.value?.id);
      // A politician, someone who has held a political position, or a party member.
      const political = occupations.includes(POLITICIAN) || (claims.P39 || []).length > 0 || (claims.P102 || []).length > 0;
      await store.savePoliticalPerson(person.wikidataId, person.name, political);
      return political;
    } catch (err) {
      log.error("political figure lookup failed", err.message);
      return false;
    }
  }

  return {
    /** { political, reason } for a post's caption, photo text and recognised people. */
    async check({ caption = "", imageText = "", people = [] }, settings) {
      if (!settings.nearby_politics_filter) return { political: false, reason: null };
      const words = wordList(settings);
      const inCaption = politicalWord(caption, words);
      if (inCaption) return { political: true, reason: `Caption mentions "${inCaption}"` };
      const inPhoto = politicalWord(imageText, words);
      if (inPhoto) return { political: true, reason: `Photo text mentions "${inPhoto}"` };
      const extraNames = String(settings.political_names || "")
        .split(/\n|,/)
        .map((n) => n.trim().toLowerCase())
        .filter(Boolean);
      for (const person of people) {
        if (await isPolitical(person, extraNames)) return { political: true, reason: `Photo shows ${person.name}` };
      }
      return { political: false, reason: null };
    },
  };
}

module.exports = { createPolitics, politicalWord, wordList, DEFAULT_WORDS };
