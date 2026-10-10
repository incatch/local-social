-- The site is called Radius.
update settings set value = 'Radius' where key = 'site_name' and value = 'Local Social';
insert into settings (key, value) values ('tagline', 'Your world. Happening now.') on conflict (key) do nothing;
