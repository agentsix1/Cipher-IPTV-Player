'use strict';

/**
 * Free XMLTV guides from epgshare01.online, offered when a playlist is added (and from the guide
 * sources editor). ALL_SOURCES is left out on purpose: it is every other file combined (~190 MB).
 */

const EPGSHARE_BASE = 'https://epgshare01.online/epgshare01/';

const EPGSHARE_FILES = [
  ['AE1', 'United Arab Emirates'], ['AL1', 'Albania'], ['ALJAZEERA1', 'Al Jazeera'], ['AR1', 'Argentina'],
  ['ASIANTELEVISION1', 'Asian Television'], ['AT1', 'Austria'], ['AU1', 'Australia'], ['AUDACY1', 'Audacy'],
  ['BA1', 'Bosnia and Herzegovina'], ['BB1', 'Barbados'], ['BE2', 'Belgium'], ['BEIN1', 'beIN Sports'],
  ['BG1', 'Bulgaria'], ['BR1', 'Brazil'], ['BR2', 'Brazil 2'], ['CA2', 'Canada'], ['CH1', 'Switzerland'],
  ['CL1', 'Chile'], ['CO1', 'Colombia'], ['CR1', 'Costa Rica'], ['CY1', 'Cyprus'], ['CZ1', 'Czechia'],
  ['DE1', 'Germany'], ['DELUXEMUSIC1', 'Deluxe Music'], ['DIRECTVSPORTS1', 'DirecTV Sports'], ['DISTROTV1', 'DistroTV'],
  ['DK1', 'Denmark'], ['DO1', 'Dominican Republic'], ['DRAFTKINGS1', 'DraftKings'], ['DUMMY_CHANNELS', 'Dummy channels'],
  ['EC1', 'Ecuador'], ['EG1', 'Egypt'], ['ES1', 'Spain'], ['FANDUEL1', 'FanDuel'], ['FI1', 'Finland'], ['FR1', 'France'],
  ['GR1', 'Greece'], ['HK1', 'Hong Kong'], ['HR1', 'Croatia'], ['HU1', 'Hungary'], ['ID1', 'Indonesia'], ['IE1', 'Ireland'],
  ['IL1', 'Israel'], ['IN1', 'India'], ['IN2', 'India 2'], ['IN4', 'India 4'], ['IT1', 'Italy'], ['JM1', 'Jamaica'],
  ['JP1', 'Japan'], ['JP2', 'Japan 2'], ['KE1', 'Kenya'], ['KR1', 'South Korea'], ['KZ1', 'Kazakhstan'], ['LT1', 'Lithuania'],
  ['LU1', 'Luxembourg'], ['LV1', 'Latvia'], ['MN1', 'Mongolia'], ['MT1', 'Malta'], ['MUSICBOX1', 'Music Box'], ['MX1', 'Mexico'],
  ['MY1', 'Malaysia'], ['NG1', 'Nigeria'], ['NL1', 'Netherlands'], ['NO1', 'Norway'], ['NZ1', 'New Zealand'], ['PA1', 'Panama'],
  ['PE1', 'Peru'], ['PEACOCK1', 'Peacock'], ['PH1', 'Philippines'], ['PH2', 'Philippines 2'], ['PK1', 'Pakistan'], ['PL1', 'Poland'],
  ['PLEX1', 'Plex'], ['PT1', 'Portugal'], ['RAKUTEN1', 'Rakuten TV'], ['RALLY_TV1', 'Rally TV'], ['RO1', 'Romania'],
  ['RO2', 'Romania 2'], ['RS1', 'Serbia'], ['SA1', 'Saudi Arabia'], ['SA2', 'Saudi Arabia 2'], ['SE1', 'Sweden'],
  ['SG1', 'Singapore'], ['SK1', 'Slovakia'], ['SPORTKLUB1', 'Sport Klub'], ['SSPORTPLUS1', 'S Sport Plus'], ['SV1', 'El Salvador'],
  ['TBNPLUS1', 'TBN Plus'], ['TH1', 'Thailand'], ['THESPORTPLUS1', 'The Sport Plus'], ['TR1', 'Turkey'], ['TR3', 'Turkey 3'],
  ['UK1', 'United Kingdom'], ['US2', 'United States'], ['US_LOCALS1', 'US locals'], ['US_SPORTS1', 'US sports'],
  ['UY1', 'Uruguay'], ['VN1', 'Vietnam'], ['VOA1', 'Voice of America'], ['WHALETVPLUS1', 'Whale TV Plus'], ['ZA1', 'South Africa'],
  ['viva-russia.ru', 'Viva Russia'],
];

/** Stable source ids ("s" + up to 16 lowercase letters/digits, as the playlist editor requires). */
function presetId(code) {
  return `s${`e${code.toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 16)}`;
}

const EPGSHARE_SOURCES = EPGSHARE_FILES.map(([code, name]) => ({
  id: presetId(code),
  name: `epgshare01 · ${name}`,
  url: `${EPGSHARE_BASE}epg_ripper_${code}.xml.gz`,
  enabled: true,
}));

if (new Set(EPGSHARE_SOURCES.map((s) => s.id)).size !== EPGSHARE_SOURCES.length) {
  throw new Error('epgshare01 preset ids collide');
}

const isEpgShareUrl = (url) => String(url || '').startsWith(EPGSHARE_BASE);

module.exports = { EPGSHARE_BASE, EPGSHARE_SOURCES, isEpgShareUrl };
