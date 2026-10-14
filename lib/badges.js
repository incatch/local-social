// Local badges: small marks for being real and out in town. Each has a
// plain rule, checked with one query; once earned, a badge stays (and its
// owner gets an Activity note). Never for follower counts or likes alone.

const BADGES = [
  { key: "founding", emoji: "🌱", name: "Founding member", how: "One of the people who started Radius in their town (the first members)." },
  { key: "local", emoji: "📍", name: "Local", how: "Share 5 photos with the “Taken here” mark." },
  { key: "regular", emoji: "⭐", name: "Regular", how: "Share on 7 different days in a month." },
  { key: "early_bird", emoji: "🌅", name: "Early bird", how: "Share 3 photos taken here before 8 am." },
  { key: "night_owl", emoji: "🌙", name: "Night owl", how: "Share 3 posts after 10 pm." },
  { key: "explorer", emoji: "🧭", name: "Explorer", how: "Post from 5 different towns." },
  { key: "in_the_moment", emoji: "🎉", name: "In the moment", how: "Be part of 3 Moments." },
  { key: "good_neighbor", emoji: "🤝", name: "Good neighbor", how: "Have 3 of your answers thanked." },
  { key: "organizer", emoji: "🔥", name: "Organizer", how: "Start a plan 3 people join." },
  { key: "ripple_maker", emoji: "🌊", name: "Ripple maker", how: "Have a post ripple all the way out." },
];
const BY_KEY = Object.fromEntries(BADGES.map((b) => [b.key, b]));

/** One query that answers, for a person, whether they've met each rule. */
function badgeQuery({ foundingLimit = 500 } = {}) {
  const limit = Math.max(1, Number.parseInt(foundingLimit, 10) || 500);
  return `select
    (select count(*) from users f where f.username is not null and (f.created_at, f.id) <= (u.created_at, u.id)) <= ${limit} as founding,
    (select count(*) from posts p where p.user_id = u.id and p.status = 'visible' and p.taken_here) >= 5 as local,
    (select count(distinct (p.created_at at time zone $2)::date) from posts p where p.user_id = u.id and p.status = 'visible' and p.created_at > now() - interval '30 days') >= 7 as regular,
    (select count(*) from posts p where p.user_id = u.id and p.status = 'visible' and p.taken_here and extract(hour from p.created_at at time zone $2) between 4 and 7) >= 3 as early_bird,
    (select count(*) from posts p where p.user_id = u.id and p.status = 'visible' and (extract(hour from p.created_at at time zone $2) >= 22 or extract(hour from p.created_at at time zone $2) < 3)) >= 3 as night_owl,
    (select count(distinct p.area_name) from posts p where p.user_id = u.id and p.status = 'visible' and p.area_name is not null) >= 5 as explorer,
    (select count(distinct mp.moment_id) from moment_posts mp join posts p on p.id = mp.post_id where p.user_id = u.id) >= 3 as in_the_moment,
    (select count(*) from signal_replies r where r.user_id = u.id and r.thanked) >= 3 as good_neighbor,
    exists (select 1 from signals s where s.user_id = u.id and s.kind = 'plan' and (select count(*) from signal_joins j where j.signal_id = s.id) >= 3) as organizer,
    exists (select 1 from posts p where p.user_id = u.id and p.status = 'visible' and p.lat is not null and p.like_count + p.comment_count >= $3) as ripple_maker
  from users u where u.id = $1`;
}

module.exports = { BADGES, BY_KEY, badgeQuery };
