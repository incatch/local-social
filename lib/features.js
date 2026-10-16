// New features the owner can switch per audience in Admin → New features:
// Off, 18+ only, or Everyone (teens too, when teen mode is on).
// Use `featureOn(settings, key, user)` everywhere a feature shows up.

const FEATURES = [
  {
    key: "pullup",
    name: "Pull Up",
    emoji: "🙋",
    what: "Tap Pull Up on a post or plan: “on my way”, then “pulled up 👋” with a quick selfie when you arrive.",
    guard: "Never shares a route or live location; only says “arrived” once you're there.",
  },
  {
    key: "squads",
    name: "Squads & IRL streaks",
    emoji: "🫂",
    what: "Groups of up to 8 friends with a squad chat and a weekly streak that only grows when they do real things together.",
    guard: "Only people who follow each other can be in a squad.",
  },
  {
    key: "drops",
    name: "Drops",
    emoji: "📍",
    what: "A photo or note pinned to a public spot that only opens when you get there. Hot-and-cold radar, “Found it” stamps.",
    guard: "Only at public places (parks, landmarks, shops), never homes or schools. Nobody sees who opened a Drop.",
  },
  {
    key: "heatmap",
    name: "Where It's At",
    emoji: "🔥",
    what: "A map that glows where lots of people are posting right now.",
    guard: "Crowds only (several different adults), at least 30 minutes late, about a mile wide; teens' posts never count.",
  },
  {
    key: "reels",
    name: "Video clips & Moment Reels",
    emoji: "🎬",
    what: "Short silent video clips in posts, and a 20-second edited video of each Moment, set to a Radius beat, for everyone in it.",
    guard: "Every frame is screened like photos; no outside music (beats are made by Radius).",
  },
];
const AUDIENCES = { off: "Off", adults: "18+ only", everyone: "Everyone" };

function featureSettings(raw) {
  const out = {};
  for (const f of FEATURES) out[f.key] = AUDIENCES[raw[`feature_${f.key}`]] ? raw[`feature_${f.key}`] : "adults";
  return out;
}

/** Is `key` switched on for this person? (`user.is_teen` is set per request.) */
function featureOn(settings, key, user) {
  const audience = (settings.features || {})[key] || "adults";
  if (audience === "everyone") return true;
  if (audience === "adults") return Boolean(user) && !user.is_teen;
  return false;
}

module.exports = { FEATURES, AUDIENCES, featureSettings, featureOn };
