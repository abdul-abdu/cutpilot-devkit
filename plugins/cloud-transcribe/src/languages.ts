/**
 * ElevenLabs answers with ISO 639-3 codes (`eng`, `uzb`); CutPilot's projects use ISO 639-1
 * (`en`, `uz`) wherever a language has one. 639-2/B spellings (`fre`, `ger`) are here too.
 */
// prettier-ignore
const ISO1: Record<string, string> = {
  afr: 'af', amh: 'am', ara: 'ar', arm: 'hy', asm: 'as', aze: 'az', bak: 'ba', baq: 'eu',
  bel: 'be', ben: 'bn', bod: 'bo', bos: 'bs', bre: 'br', bul: 'bg', bur: 'my', cat: 'ca',
  ces: 'cs', chi: 'zh', cmn: 'zh', cym: 'cy', cze: 'cs', dan: 'da', deu: 'de', dut: 'nl',
  ell: 'el', eng: 'en', est: 'et', eus: 'eu', fao: 'fo', fas: 'fa', fin: 'fi', fra: 'fr',
  fre: 'fr', ful: 'ff', geo: 'ka', ger: 'de', gle: 'ga', glg: 'gl', gre: 'el', guj: 'gu',
  hat: 'ht', hau: 'ha', heb: 'he', hin: 'hi', hrv: 'hr', hun: 'hu', hye: 'hy', ibo: 'ig',
  ice: 'is', ind: 'id', isl: 'is', ita: 'it', jav: 'jv', jpn: 'ja', kan: 'kn', kat: 'ka',
  kaz: 'kk', khm: 'km', kin: 'rw', kir: 'ky', kor: 'ko', kur: 'ku', lao: 'lo', lat: 'la',
  lav: 'lv', lin: 'ln', lit: 'lt', ltz: 'lb', lug: 'lg', mac: 'mk', mal: 'ml', mar: 'mr',
  may: 'ms', mkd: 'mk', mlg: 'mg', mlt: 'mt', mon: 'mn', mri: 'mi', msa: 'ms', mya: 'my',
  nep: 'ne', nld: 'nl', nob: 'nb', nno: 'nn', nor: 'no', nya: 'ny', oci: 'oc', ori: 'or',
  pan: 'pa', per: 'fa', pol: 'pl', por: 'pt', pus: 'ps', ron: 'ro', rum: 'ro', rus: 'ru',
  san: 'sa', sin: 'si', slk: 'sk', slo: 'sk', slv: 'sl', sna: 'sn', snd: 'sd', som: 'so',
  spa: 'es', sqi: 'sq', alb: 'sq', srp: 'sr', sun: 'su', swa: 'sw', swe: 'sv', tam: 'ta',
  tat: 'tt', tel: 'te', tgk: 'tg', tgl: 'tl', tha: 'th', tuk: 'tk', tur: 'tr', uig: 'ug',
  ukr: 'uk', urd: 'ur', uzb: 'uz', vie: 'vi', wel: 'cy', wol: 'wo', xho: 'xh', yid: 'yi',
  yor: 'yo', zho: 'zh', zul: 'zu',
};

/**
 * The language to report: the 639-1 code of what ElevenLabs heard; else the code the project
 * asked for; else ElevenLabs' own code when it is a plain 3-letter one (Cantonese is `yue`).
 */
export function reportedLanguage(heard: string | null | undefined, asked: string): string {
  const code = (heard ?? '').trim().toLowerCase().split(/[-_]/)[0]!;
  if (/^[a-z]{2}$/.test(code)) return code;
  if (ISO1[code]) return ISO1[code];
  if (asked !== 'auto') return asked;
  return /^[a-z]{3}$/.test(code) ? code : 'und';
}
