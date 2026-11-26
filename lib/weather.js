'use strict';
// ── WEATHER, IN ONE CALL ─────────────────────────────────────────────────────────────────────────
//
// 25 Nov: "what's the weather like tomorrow?" took 10.5 s and six model round trips — web search was
// dead (DuckDuckGo now answers automated requests with a bot challenge), so the model scraped five
// weather pages by hand. Weather is structured data with a free, keyless API (Open-Meteo), so it gets
// a tool that answers in ~300 ms with real numbers instead of whatever a page happened to say.
//
// Privacy: the location sent is rounded to 0.1° (~10 km) — enough for a forecast, not an address.
// A named place is geocoded by Open-Meteo itself; nothing else about him leaves the Mac.

const WMO = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'rain showers', 81: 'rain showers',
  82: 'violent rain showers', 85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with hail',
};
const round1 = (x) => Math.round(Number(x) * 10) / 10;
// Open-Meteo returns state NAMES ("New Jersey"); people type codes ("NJ"). Without this, "Princeton, NJ"
// resolved to Princeton, Indiana.
const US = { al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado', ct: 'connecticut', de: 'delaware', fl: 'florida', ga: 'georgia', hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi', mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico', ny: 'new york', nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina', sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont', va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming', dc: 'district of columbia' };

async function getJson(url, fetchImpl = fetch, timeoutMs = 6000) {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/** { place?: 'Princeton, NJ', lat?, lon?, days?: 1-7, units?: 'f'|'c' } → a compact forecast. */
async function forecast({ place, lat, lon, label, days = 3, units = 'f', fetchImpl = fetch } = {}) {
  let where = label || '';
  if (place && String(place).trim()) {
    const name = String(place).split(',')[0].trim();
    const g = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=20&language=en&format=json`, fetchImpl);
    const hits = (g && g.results) || [];
    // "Princeton, NJ" — prefer the hit whose state/country matches what follows the comma.
    const q0 = String(place).split(',').slice(1).join(',').trim().toLowerCase();
    const qual = US[q0] || q0;
    const byPop = hits.slice().sort((a, b) => (b.population || 0) - (a.population || 0));
    const hit = (qual && byPop.find((h) => [h.admin1, h.admin1_code, h.country, h.country_code].some((v) => v && String(v).toLowerCase().startsWith(qual)))) || byPop[0];
    if (!hit) return { ok: false, error: `couldn't find a place called "${place}"` };
    lat = hit.latitude; lon = hit.longitude;
    where = [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(', ');
  }
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return { ok: false, error: 'no location — pass a place, or set config.geo' };
  const f = units === 'c' ? '' : '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch';
  const n = Math.max(1, Math.min(7, Number(days) || 3));
  const j = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${round1(lat)}&longitude=${round1(lon)}`
    + `&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m`
    + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max`
    + `&timezone=auto&forecast_days=${n}${f}`, fetchImpl);
  const u = units === 'c' ? '°C' : '°F';
  const c = j.current || {}, d = j.daily || {};
  const out = {
    ok: true, where: where || `${round1(lat)}, ${round1(lon)}`, units: u,
    now: c.temperature_2m != null ? { temp: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature), sky: WMO[c.weather_code] || 'unknown', wind: Math.round(c.wind_speed_10m) } : null,
    days: (d.time || []).map((date, i) => ({
      date, sky: WMO[d.weather_code[i]] || 'unknown', high: Math.round(d.temperature_2m_max[i]), low: Math.round(d.temperature_2m_min[i]),
      rainChance: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null,
      precip: d.precipitation_sum ? d.precipitation_sum[i] : null, wind: d.wind_speed_10m_max ? Math.round(d.wind_speed_10m_max[i]) : null,
    })),
  };
  return out;
}

/** One line per day — what the model reads and can say aloud. */
function format(w) {
  if (!w || !w.ok) return (w && w.error) || 'weather unavailable';
  const lines = [`Weather for ${w.where}.`];
  if (w.now) lines.push(`Now: ${w.now.temp}${w.units} (feels ${w.now.feels}${w.units}), ${w.now.sky}, wind ${w.now.wind}.`);
  for (const d of w.days) lines.push(`${d.date}: ${d.sky}, high ${d.high}${w.units}, low ${d.low}${w.units}${d.rainChance != null ? `, ${d.rainChance}% chance of precipitation` : ''}${d.wind != null ? `, wind up to ${d.wind}` : ''}.`);
  return lines.join('\n');
}

module.exports = { forecast, format, WMO };
