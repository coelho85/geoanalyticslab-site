// Site-specific settings of the forest check (geoanalyticslab.com). Other installations use their own values.
export const CONFIG = {
  // tiles.json of the JRC GFC2020 v4 10° COG tiles (see tools/build_tiles.py)
  TILES_MANIFEST: 'https://maps.geoanalyticslab.com/gfc2020/v4/cog10/tiles.json',
  // Mapbox public token (account without a card: hard stop at the free limit). Empty = Sentinel-2 basemap only.
  MAPBOX_TOKEN: 'pk.eyJ1IjoiY29lbGhvODUiLCJhIjoiY213dzgxdnVqMDBlaTJ6c2V1aGdvdWRmYiJ9.UfiAilJfhHqePI7P4a7yBg',
  // Registration endpoint (Cloudflare Worker, worker-forms/). Empty = download without registration.
  FORMS_URL: 'https://forms.geoanalyticslab.com/lead',
  // Optional Cloudflare Turnstile site key (spam protection for the registration)
  TURNSTILE_SITEKEY: '',
};
