/**
 * Language codes. CutPilot speaks ISO 639-1 (`en`, `ru`, `uz`); OpenAI answers with an English
 * name (`english`), ElevenLabs with ISO 639-3 (`eng`) or 639-1. Both map to 639-1 here; a
 * language without a two-letter code keeps its three-letter one (the contract allows it).
 */

/** The names OpenAI's whisper-1 reports, and a few other spellings of them. */
const NAMES: Record<string, string> = {
  afrikaans: 'af',
  albanian: 'sq',
  amharic: 'am',
  arabic: 'ar',
  armenian: 'hy',
  assamese: 'as',
  azerbaijani: 'az',
  bashkir: 'ba',
  basque: 'eu',
  belarusian: 'be',
  bengali: 'bn',
  bosnian: 'bs',
  breton: 'br',
  bulgarian: 'bg',
  burmese: 'my',
  cantonese: 'yue',
  castilian: 'es',
  catalan: 'ca',
  chinese: 'zh',
  croatian: 'hr',
  czech: 'cs',
  danish: 'da',
  dutch: 'nl',
  english: 'en',
  estonian: 'et',
  faroese: 'fo',
  finnish: 'fi',
  flemish: 'nl',
  french: 'fr',
  galician: 'gl',
  georgian: 'ka',
  german: 'de',
  greek: 'el',
  gujarati: 'gu',
  haitian: 'ht',
  'haitian creole': 'ht',
  hausa: 'ha',
  hawaiian: 'haw',
  hebrew: 'he',
  hindi: 'hi',
  hungarian: 'hu',
  icelandic: 'is',
  indonesian: 'id',
  italian: 'it',
  japanese: 'ja',
  javanese: 'jv',
  kannada: 'kn',
  kazakh: 'kk',
  khmer: 'km',
  korean: 'ko',
  lao: 'lo',
  latin: 'la',
  latvian: 'lv',
  letzeburgesch: 'lb',
  lingala: 'ln',
  lithuanian: 'lt',
  luxembourgish: 'lb',
  macedonian: 'mk',
  malagasy: 'mg',
  malay: 'ms',
  malayalam: 'ml',
  maltese: 'mt',
  mandarin: 'zh',
  maori: 'mi',
  marathi: 'mr',
  moldavian: 'ro',
  moldovan: 'ro',
  mongolian: 'mn',
  myanmar: 'my',
  nepali: 'ne',
  norwegian: 'no',
  nynorsk: 'nn',
  occitan: 'oc',
  panjabi: 'pa',
  pashto: 'ps',
  persian: 'fa',
  polish: 'pl',
  portuguese: 'pt',
  punjabi: 'pa',
  pushto: 'ps',
  romanian: 'ro',
  russian: 'ru',
  sanskrit: 'sa',
  serbian: 'sr',
  shona: 'sn',
  sindhi: 'sd',
  sinhala: 'si',
  sinhalese: 'si',
  slovak: 'sk',
  slovenian: 'sl',
  somali: 'so',
  spanish: 'es',
  sundanese: 'su',
  swahili: 'sw',
  swedish: 'sv',
  tagalog: 'tl',
  tajik: 'tg',
  tamil: 'ta',
  tatar: 'tt',
  telugu: 'te',
  thai: 'th',
  tibetan: 'bo',
  turkish: 'tr',
  turkmen: 'tk',
  ukrainian: 'uk',
  urdu: 'ur',
  uzbek: 'uz',
  valencian: 'ca',
  vietnamese: 'vi',
  welsh: 'cy',
  yiddish: 'yi',
  yoruba: 'yo',
};

/** ISO 639-3 (and the 639-2 bibliographic spellings) → 639-1. */
const THREE: Record<string, string> = Object.fromEntries(
  `
  afr:af amh:am ara:ar arb:ar asm:as aze:az bak:ba bel:be ben:bn bod:bo tib:bo bos:bs bre:br
  bul:bg cat:ca ces:cs cze:cs cmn:zh zho:zh chi:zh cym:cy wel:cy dan:da deu:de ger:de ell:el
  gre:el eng:en epo:eo est:et eus:eu baq:eu fao:fo fas:fa per:fa pes:fa fil:tl fin:fi fra:fr
  fre:fr ful:ff gle:ga glg:gl guj:gu hat:ht hau:ha heb:he hin:hi hrv:hr hun:hu hye:hy arm:hy
  ibo:ig ind:id isl:is ice:is ita:it jav:jv jpn:ja kan:kn kat:ka geo:ka kaz:kk khm:km kin:rw
  kir:ky kor:ko kur:ku lao:lo lat:la lav:lv lvs:lv lin:ln lit:lt ltz:lb lug:lg mal:ml mar:mr
  mkd:mk mac:mk mlg:mg mlt:mt mon:mn khk:mn mri:mi mao:mi msa:ms may:ms zsm:ms mya:my bur:my
  nep:ne npi:ne nld:nl dut:nl nno:nn nob:nb nor:no nya:ny oci:oc ori:or ory:or orm:om pan:pa
  pol:pl por:pt pus:ps pbt:ps ron:ro rum:ro rus:ru san:sa sin:si slk:sk slo:sk slv:sl sna:sn
  snd:sd som:so spa:es sqi:sq alb:sq srp:sr sun:su swa:sw swh:sw swe:sv tam:ta tat:tt tel:te
  tgk:tg tgl:tl tha:th tir:ti tuk:tk tur:tr uig:ug ukr:uk urd:ur uzb:uz uzn:uz vie:vi wol:wo
  xho:xh yid:yi yor:yo zul:zu
  `
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(':')),
);

const CODE = /^[a-z]{2,3}$/;

/**
 * A provider's language as ISO 639-1: a name (`English`), a 639-3 code (`eng`), a 639-1 code,
 * or a tag with a region (`en-US`). Null when it can't be told.
 */
export function toIso1(language: string | null | undefined): string | null {
  if (!language) return null;
  const l = language.trim().toLowerCase().replace(/_/g, '-');
  if (NAMES[l]) return NAMES[l]!;
  const base = l.split('-')[0]!;
  if (base.length === 2 && CODE.test(base)) return base;
  if (THREE[base]) return THREE[base]!;
  return CODE.test(base) ? base : null;
}
