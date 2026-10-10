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
// - allow:  everything else (swimwear, alcohol and so on are fine).
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
  // Partial nudity (but not swimwear, a bare back or a shirtless guy at the lake).
  "Partially Exposed Female Breast", "Partially Exposed Buttocks", "Implied Nudity", "Obstructed Intimate Parts", "Partial Nudity",
  // Violence, gore, disturbing images and hate symbols.
  "Violence", "Graphic Violence", "Graphic Violence Or Gore", "Physical Violence", "Weapon Violence", "Self-Harm", "Self Injury",
  "Visually Disturbing", "Death and Emaciation", "Emaciated Bodies", "Corpses", "Crashes", "Air Crash", "Explosions and Blasts",
  "Hate Symbols", "Nazi Party", "White Supremacy", "Extremist",
]);
const REFUSE_CONFIDENCE = 80;
const HOLD_CONFIDENCE = 75;

/** Turns Rekognition's labels into allow / hold / refuse. */
function decide(labels) {
  let action = "allow";
  for (const l of labels) {
    const listed = (set) => set.has(l.name) || set.has(l.parent);
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
    async screen(image) {
      try {
        // Rekognition takes JPEG or PNG.
        const jpeg = await sharp(image).jpeg({ quality: 85 }).toBuffer();
        const out = await client.send(new DetectModerationLabelsCommand({ Image: { Bytes: jpeg }, MinConfidence: MIN_CONFIDENCE }));
        const labels = (out.ModerationLabels || []).map((l) => ({
          name: l.Name,
          parent: l.ParentName || "",
          confidence: Math.round(l.Confidence * 10) / 10,
        }));
        return { action: decide(labels), labels };
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
