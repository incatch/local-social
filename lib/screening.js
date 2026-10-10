// Automatic photo screening, before anyone sees a photo.
//
// Every photo (posts, profile photos, snaps) goes to Amazon Rekognition's
// moderation check, which answers with labels like "Explicit Nudity" and how
// sure it is. Then:
//
// - refuse: clearly explicit. The upload is turned down (and a copy goes to
//   the moderated-out store with the labels).
// - hold:   might break the rules (partial nudity, violence, gore, hate
//   symbols). A post waits for the owner's review, hidden from everyone but
//   its author; a profile photo or snap is turned down.
// - allow:  everything else. Swimwear is fine, including thongs (a bare
//   bottom), and so are alcohol, a bare back or a shirtless guy at the lake.
//
// Rekognition can't recognise abuse of children. Anything reported as
// involving a minor goes to the owner straight away (see safety-store.js).

const sharp = require("sharp");

const MIN_CONFIDENCE = 60;
// Rekognition's label names (its 2024 list, plus the older one). A label
// counts if its own name or its parent's is listed.
const REFUSE = new Set([
  "Explicit", "Explicit Nudity", "Explicit Sexual Activity", "Sex Toys",
  "Nudity", "Graphic Male Nudity", "Graphic Female Nudity", "Sexual Activity", "Illustrated Explicit Nudity", "Adult Toys",
]);
const HOLD = new Set([
  // Partial nudity (but not swimwear, a bare bottom, a bare back or a shirtless guy at the lake).
  "Partially Exposed Female Breast", "Implied Nudity", "Obstructed Intimate Parts", "Partial Nudity",
  // Violence, gore, disturbing images and hate symbols.
  "Violence", "Graphic Violence", "Graphic Violence Or Gore", "Physical Violence", "Weapon Violence", "Self-Harm", "Self Injury",
  "Visually Disturbing", "Death and Emaciation", "Emaciated Bodies", "Corpses", "Crashes", "Air Crash", "Explosions and Blasts",
  "Hate Symbols", "Nazi Party", "White Supremacy", "Extremist",
]);
// Rekognition files a fully bare bottom under explicit nudity, but the owner
// allows bare bottoms (thong swimsuits), so it's never refused, only held
// for a look in case it's more than that.
const REVIEW_ONLY = new Set(["Exposed Buttocks or Anus"]);
// Fine whatever their parent label says.
const ALLOW = new Set(["Partially Exposed Buttocks"]);
// Teen accounts (when Admin → Teen mode keeps strict screening on): their
// photos showing swimwear, underwear or any partial nudity are held too.
const TEEN_HOLD = new Set([
  "Swimwear or Underwear", "Female Swimwear Or Underwear", "Male Swimwear Or Underwear",
  "Non-Explicit Nudity", "Non-Explicit Nudity of Intimate parts and Kissing", "Partially Exposed Buttocks", "Bare Back",
  "Exposed Male Nipple", "Suggestive", "Revealing Clothes", "Female Swimwear Or Underwear", "Male Swimwear Or Underwear",
]);
const REFUSE_CONFIDENCE = 80;
const HOLD_CONFIDENCE = 75;

/** Turns Rekognition's labels into allow / hold / refuse (`strict` for teen accounts). */
function decide(labels, { strict = false } = {}) {
  let action = "allow";
  for (const l of labels) {
    const listed = (set) => set.has(l.name) || set.has(l.parent);
    if (strict && listed(TEEN_HOLD) && l.confidence >= HOLD_CONFIDENCE) action = "hold";
    if (ALLOW.has(l.name)) continue;
    if (REVIEW_ONLY.has(l.name)) {
      if (l.confidence >= HOLD_CONFIDENCE) action = "hold";
      continue;
    }
    if (listed(REFUSE) && l.confidence >= REFUSE_CONFIDENCE) return "refuse";
    if ((listed(REFUSE) || listed(HOLD)) && l.confidence >= HOLD_CONFIDENCE) action = "hold";
  }
  return action;
}

/** The real screener (AWS). */
function createRekognitionScreener({ region, log = console }) {
  const { RekognitionClient, DetectModerationLabelsCommand } = require("@aws-sdk/client-rekognition");
  const client = new RekognitionClient({ region });
  return {
    /** { action, labels } for an image (any format sharp reads). */
    async screen(image, { strict = false } = {}) {
      try {
        // Rekognition takes JPEG or PNG.
        const jpeg = await sharp(image).jpeg({ quality: 85 }).toBuffer();
        const out = await client.send(new DetectModerationLabelsCommand({ Image: { Bytes: jpeg }, MinConfidence: MIN_CONFIDENCE }));
        const labels = (out.ModerationLabels || []).map((l) => ({
          name: l.Name,
          parent: l.ParentName || "",
          confidence: Math.round(l.Confidence * 10) / 10,
        }));
        return { action: decide(labels, { strict }), labels };
      } catch (err) {
        // If screening is down, posts wait for review rather than going out unchecked.
        log.error("photo screening failed", err);
        return { action: "hold", labels: [{ name: "Screening unavailable", parent: "", confidence: 0 }] };
      }
    },
  };
}

/** For your own computer: everything's allowed. */
const allowAll = { screen: async () => ({ action: "allow", labels: [] }) };

module.exports = { createRekognitionScreener, allowAll, decide };
