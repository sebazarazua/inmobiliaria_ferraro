const GEOREF_BASE = 'https://apis.datos.gob.ar/georef/api';

const FALLBACK_PROVINCES = [
  'Buenos Aires',
  'CABA',
  'Catamarca',
  'Chaco',
  'Chubut',
  'Córdoba',
  'Corrientes',
  'Entre Ríos',
  'Formosa',
  'Jujuy',
  'La Pampa',
  'La Rioja',
  'Mendoza',
  'Misiones',
  'Neuquén',
  'Río Negro',
  'Salta',
  'San Juan',
  'San Luis',
  'Santa Cruz',
  'Santa Fe',
  'Santiago del Estero',
  'Tierra del Fuego',
  'Tucumán'
];

const CABA_BARRIOS = [
  'Agronomía',
  'Almagro',
  'Balvanera',
  'Barracas',
  'Belgrano',
  'Boedo',
  'Caballito',
  'Chacarita',
  'Coghlan',
  'Colegiales',
  'Constitución',
  'Flores',
  'Floresta',
  'La Boca',
  'La Paternal',
  'Liniers',
  'Mataderos',
  'Monte Castro',
  'Monserrat',
  'Nueva Pompeya',
  'Núñez',
  'Palermo',
  'Parque Avellaneda',
  'Parque Chacabuco',
  'Parque Chas',
  'Parque Patricios',
  'Puerto Madero',
  'Recoleta',
  'Retiro',
  'Saavedra',
  'San Cristóbal',
  'San Nicolás',
  'San Telmo',
  'Vélez Sarsfield',
  'Versalles',
  'Villa Crespo',
  'Villa del Parque',
  'Villa Devoto',
  'Villa General Mitre',
  'Villa Lugano',
  'Villa Luro',
  'Villa Ortúzar',
  'Villa Pueyrredón',
  'Villa Real',
  'Villa Riachuelo',
  'Villa Santa Rita',
  'Villa Soldati',
  'Villa Urquiza'
];

const cache = new Map();

function normalizeProvinceName(value = '') {
  const normalized = String(value).toLocaleLowerCase('es-AR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  if (['caba', 'capital federal', 'ciudad autonoma de buenos aires', 'ciudad de buenos aires'].includes(normalized)) return 'CABA';
  return String(value || '').trim();
}

function isCaba(value = '') {
  return normalizeProvinceName(value) === 'CABA';
}

async function getJson(url, ttlMs = 24 * 60 * 60 * 1000) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.at < ttlMs) return cached.value;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Georef respondió ${response.status}`);
    const value = await response.json();
    cache.set(url, { at: Date.now(), value });
    return value;
  } finally {
    clearTimeout(timeout);
  }
}

async function provinces() {
  try {
    const url = `${GEOREF_BASE}/provincias?campos=nombre&max=30`;
    const payload = await getJson(url);
    const names = payload.provincias.map(item => normalizeProvinceName(item.nombre)).sort((a,b) => a.localeCompare(b, 'es'));
    return Array.from(new Set(names));
  } catch {
    return FALLBACK_PROVINCES;
  }
}

async function localities(province) {
  const normalizedProvince = normalizeProvinceName(province);
  if (!normalizedProvince) return [];
  if (isCaba(normalizedProvince)) return CABA_BARRIOS;
  const url = `${GEOREF_BASE}/localidades?provincia=${encodeURIComponent(normalizedProvince)}&campos=nombre&max=5000`;
  const payload = await getJson(url);
  return Array.from(new Set((payload.localidades || []).map(item => item.nombre).filter(Boolean))).sort((a,b) => a.localeCompare(b, 'es'));
}

module.exports = { provinces, localities, normalizeProvinceName, isCaba, CABA_BARRIOS };
