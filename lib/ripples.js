// Ripples: a post starts by reaching people close by, and reaches further
// (in rings, like the logo) as people like and comment on it. Good local
// posts spread the way news does in a town. The rings are settings in
// Admin → Nearby rules.

/** The ripple settings, with safe defaults. */
function rippleSettings(raw) {
  const num = (v, dflt) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dflt);
  const s = {
    ripples_enabled: raw.ripples_enabled !== "false" && raw.ripples_enabled !== false,
    ripple_start_miles: num(raw.ripple_start_miles, 10),
    ripple_2_at: num(raw.ripple_2_at, 3),
    ripple_2_miles: num(raw.ripple_2_miles, 25),
    ripple_3_at: num(raw.ripple_3_at, 10),
    ripple_3_miles: num(raw.ripple_3_miles, 50),
    nearby_days: num(raw.nearby_days, 14),
  };
  return s;
}

/** How far a post with this many likes + comments reaches (miles), or Infinity when ripples are off. */
function reachMiles(engagement, s) {
  if (!s.ripples_enabled) return Infinity;
  if (engagement >= s.ripple_3_at) return s.ripple_3_miles;
  if (engagement >= s.ripple_2_at) return s.ripple_2_miles;
  return s.ripple_start_miles;
}

/** The same as SQL, for the Nearby query ($params are the settings, in order). */
function reachSql(engagementSql, [startParam, at2, miles2, at3, miles3, enabledParam]) {
  return `(case when not ${enabledParam}::boolean then 100000::float
                when ${engagementSql} >= ${at3}::int then ${miles3}::float
                when ${engagementSql} >= ${at2}::int then ${miles2}::float
                else ${startParam}::float end)`;
}

module.exports = { rippleSettings, reachMiles, reachSql };
