// The site's icons, drawn as simple line SVGs (24×24, using the text colour).

const PATHS = {
  home: '<path d="M4 11.5 12 5l8 6.5"/><path d="M6 10v9h4.5v-5h3v5H18v-9"/>',
  chat: '<path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4 3.5V16h0a2.5 2.5 0 0 1-2-2.5z"/>',
  plus: '<path d="M12 6v12M6 12h12"/>',
  bell: '<path d="M7 16V11a5 5 0 0 1 10 0v5l1.5 2h-13z"/><path d="M10.5 20.5a1.8 1.8 0 0 0 3 0"/>',
  heart: '<path d="M12 19s-7-4.3-7-9.2A3.8 3.8 0 0 1 12 7.6a3.8 3.8 0 0 1 7 2.2C19 14.7 12 19 12 19z"/>',
  comment: '<path d="M20 11.5a7.5 7 0 0 1-11 6.2L5 19l1.2-3.5A7 7 0 1 1 20 11.5z"/>',
  camera: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7H8l1.5-2h5L16 7h2.5A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="13" r="3.5"/>',
  images: '<rect x="3.5" y="6.5" width="13" height="13" rx="2"/><path d="M7.5 3.5h10a3 3 0 0 1 3 3v10"/><path d="m3.5 16 4-4 4 4 2-2 3 3"/>',
  pin: '<path d="M12 21s-6-5.6-6-10.5a6 6 0 0 1 12 0C18 15.4 12 21 12 21z"/><circle cx="12" cy="10.5" r="2.2"/>',
  gear: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  more: '<circle cx="6" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18" cy="12" r="1.3" fill="currentColor"/>',
  ripple: '<circle cx="12" cy="12" r="2.2"/><circle cx="12" cy="12" r="5.6" opacity=".75"/><circle cx="12" cy="12" r="9" opacity=".45"/>',
  check: '<path d="M5 12.5 10 17l9-10"/>',
  close: '<path d="M7 7l10 10M17 7 7 17"/>',
  next: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
  back: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  send: '<path d="M4.5 12 19.5 5l-4 14.5-3.5-5.5z"/><path d="M12 14l7.5-9"/>',
};

/** An icon by name. `filled` fills the shape too (a liked heart). */
function icon(name, { size = 24, filled = false, label = "" } = {}) {
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${filled ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${PATHS[name]}</svg>`;
}

module.exports = { icon };
