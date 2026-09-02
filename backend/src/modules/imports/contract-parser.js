const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { uid, normalizeAddress, allSettings } = require('../../database');

const MONTHS = { enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6, julio:7, agosto:8, septiembre:9, setiembre:9, octubre:10, noviembre:11, diciembre:12 };
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const digits = value => String(value || '').replace(/\D/g, '');
const iso = (day, month, year) => `${year}-${String(MONTHS[month.toLowerCase()]).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
const roundConfidence = value => Math.round(value * 100) / 100;
const PERSON_NAME = '([A-ZÁÉÍÓÚÑ][A-Za-zÀ-ÿ\'".-]+(?:\\s+[A-ZÁÉÍÓÚÑ][A-Za-zÀ-ÿ\'".-]+){1,7})';
const moneyValue = value => {
  const source = String(value || '').trim();
  if (!source) return null;
  if (source.includes(',') && source.includes('.')) return Number(source.replace(/\./g,'').replace(',', '.'));
  if (source.includes(',')) return Number(source.replace(/\./g,'').replace(',', '.'));
  return Number(source.replace(/\./g,''));
};
const levenshtein = (a='', b='') => {
  const left = normalizeAddress(a), right = normalizeAddress(b);
  if (!left || !right) return 999;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let last = i - 1;
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const old = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, last + (left[i - 1] === right[j - 1] ? 0 : 1));
      last = old;
    }
  }
  return previous[right.length];
};
const similarity = (a='', b='') => {
  const max = Math.max(normalizeAddress(a).length, normalizeAddress(b).length, 1);
  return 1 - Math.min(levenshtein(a,b), max) / max;
};
const titleCase = value => clean(value).toLocaleLowerCase('es-AR').replace(/\b\p{L}/gu, char => char.toLocaleUpperCase('es-AR'));

function parseAddressComponents(address = '') {
  const source = clean(address).replace(/[“”"]/g, '');
  const withoutCity = source.replace(/,\s*(?:CABA|CAPITAL FEDERAL|CIUDAD AUT[ÓO]NOMA DE BUENOS AIRES|BUENOS AIRES|ARGENTINA).*$/i, '');
  const match = withoutCity.match(/^(.+?)\s+(\d{1,5})(?:\s+(?:(\d{1,2})\s*°?|PB|P\.?\s*B\.?|planta baja))?(?:\s*(?:depto\.?|departamento|unidad|of\.?|oficina)?\s*([A-Z0-9]+))?$/i);
  const floorRaw = clean(match?.[3] || (/\bPB\b|planta baja/i.test(withoutCity) ? 'PB' : ''));
  return {
    country: 'Argentina',
    province: /buenos aires|gba|provincia/i.test(source) && !/caba|capital federal|ciudad aut/i.test(source) ? 'Buenos Aires' : 'CABA',
    neighborhood: null,
    city: /buenos aires|gba|provincia/i.test(source) && !/caba|capital federal|ciudad aut/i.test(source) ? 'Buenos Aires' : null,
    street: titleCase(match?.[1] || withoutCity),
    streetNumber: clean(match?.[2] || ''),
    floor: floorRaw || null,
    unit: clean(match?.[4] || '').toUpperCase() || null,
    formatted: source
  };
}

function field(value, evidence, confidence = 0.8, sourceType = 'EXPLICIT') {
  return {
    value: value ?? null,
    confidence,
    evidence: clean(evidence || ''),
    status: value === null || value === undefined || value === '' ? 'NOT_FOUND' : 'DETECTED',
    sourceType
  };
}

async function extractPdfText(filename) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filename));
  const pdf = await getDocument({ data, useSystemFonts: true }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(content.items.map(item => item.str).join(' '));
  }
  return clean(pages.join('\n'));
}

function parsePeople(fragment) {
  const people = [];
  const re = new RegExp(`(?:Sres?\\.?|Sra\\.?|Sr\\.?)?\\s*${PERSON_NAME}\\s*,?\\s*(?:D\\.?\\s*N\\.?\\s*I\\.?|C\\.?\\s*U\\.?\\s*I\\.?\\s*T\\.?)\\s*(?:ficticio)?\\s*(?:N[°ºo]\\s*)?([\\d.\\-]+)`,'gi');
  let match;
  while ((match = re.exec(fragment))) {
    const fullName = clean(match[1]).replace(/^.*?\b(?:Sres?\.?|Sra\.?|Sr\.?)\s+/i, '').replace(/^(?:los|las|la|el)\s+/i, '').replace(/\s+(?:en adelante|con domicilio especial).*$/i, '');
    const documentNumber = digits(match[2]);
    if (fullName && documentNumber && !people.some(p => p.documentNumber === documentNumber)) people.push({ fullName, documentNumber });
  }
  return people;
}

function addMonths(dateString, count) {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + count, day));
  return date.toISOString().slice(0,10);
}

function buildEndDate(startDate, durationMonths) {
  const end = new Date(`${addMonths(startDate, durationMonths)}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0,10);
}

function describeMissingFields(parsed) {
  const fields = [];
  if (!parsed.address) fields.push({ key: 'address', label: 'propiedad', message: 'Falta la dirección del inmueble.' });
  if (!parsed.owners?.length) fields.push({ key: 'owner', label: 'propietario', message: 'Falta al menos un propietario.' });
  const tenants = parsed.tenants?.length ? parsed.tenants : (parsed.tenant ? [parsed.tenant] : []);
  if (!tenants.some(tenant => tenant?.fullName && tenant?.documentNumber)) fields.push({ key: 'tenant', label: 'inquilino', message: 'Faltan nombre y DNI/CUIT de al menos un inquilino.' });
  if (!parsed.startDate) fields.push({ key: 'start_date', label: 'inicio', message: 'Falta la fecha de inicio del contrato.' });
  if (!parsed.durationMonths && !parsed.endDate) fields.push({ key: 'duration_months', label: 'duración', message: 'Falta la duración o la fecha de finalización.' });
  if (!parsed.endDate && parsed.startDate && parsed.durationMonths) fields.push({ key: 'end_date', label: 'finalización', message: 'Falta la fecha de finalización del contrato.' });
  if (parsed.initialAmount == null) fields.push({ key: 'initial_amount', label: 'canon inicial', message: 'Falta el canon inicial.' });
  if (!parsed.currency) fields.push({ key: 'currency', label: 'moneda', message: 'Falta la moneda del contrato.' });
  if (!parsed.adjustmentType && !parsed.adjustmentIndex) fields.push({ key: 'adjustment_type', label: 'tipo de ajuste', message: 'Falta definir el tipo de ajuste.' });
  if ((parsed.adjustmentType === 'IPC' || parsed.adjustmentType === 'ICL' || parsed.adjustmentIndex) && !parsed.adjustmentFrequencyMonths) fields.push({ key: 'adjustment_frequency_months', label: 'frecuencia de ajuste', message: 'Falta la frecuencia de ajuste.' });
  if (!parsed.paymentPeriodEndDay && !parsed.paymentDueDay) fields.push({ key: 'payment_due_day', label: 'vencimiento', message: 'Falta el día o período de vencimiento.' });
  return fields;
}

function summarizeMissingFields(fields) {
  return `Faltan completar: ${fields.map(field => field.label).join(', ')}.`;
}

function parseContractText(text, filename = '') {
  const warnings = [];
  const normalized = clean(text);
  const filenameAddress = filename.match(/VIVIENDA\.\s*(.+?)(?:\s+CON\s+|\.pdf$)/i)?.[1];
  const addressMatch = normalized.match(/(?:inmueble(?:\s+propiedad\s+del\s+\w+)?|unidad locada|propiedad)\s*,?\s*sito en\s+(.+?)(?:,\s*compuesto|,\s*destinad|\.-?\s*SEGUNDA|SEGUNDA:)/i)
    || normalized.match(/da en locaci[oó]n.+?sito en\s+(.+?)(?:,\s*compuesto|,\s*destinad|\.-?\s*SEGUNDA|SEGUNDA:)/i);
  const address = clean(clean(addressMatch?.[1] || filenameAddress || '').replace(/,\s*de esta ciudad$/i,'').replace(/[.,-]+$/, ''));

  const partiesEnd = normalized.search(/convienen en celebrar|PRIMERA:/i);
  const parties = normalized.slice(0, partiesEnd > 0 ? partiesEnd : 1200);
  const tenantSegment = parties.match(/por la otra(?:\s+parte)?(.+)$/i)?.[1] || '';
  const ownerSegment = parties.replace(/por la otra(?:\s+parte)?.+$/i, '');
  const ownerByRole = ownerSegment.match(new RegExp(`Entre.{0,220}?(?:Sra\\.?|Sr\\.?)\\s*${PERSON_NAME}\\s*,?\\s*(?:D\\.?\\s*N\\.?\\s*I\\.?|C\\.?\\s*U\\.?\\s*I\\.?\\s*T\\.?)\\s*(?:ficticio)?\\s*(?:N[°ºo]\\s*)?([\\d.\\-]+)`,'i'));
  const tenantByRole = tenantSegment.match(new RegExp(`por\\s+la\\s+otra(?:\\s+parte)?\\s+(?:el|la)?\\s*(?:Sr\\.?|Sra\\.?)\\s*${PERSON_NAME}\\s*,?\\s*(?:D\\.?\\s*N\\.?\\s*I\\.?|C\\.?\\s*U\\.?\\s*I\\.?\\s*T\\.?)\\s*(?:ficticio)?\\s*(?:N[°ºo]\\s*)?([\\d.\\-]+)`,'i'));
  const owners = parsePeople(ownerSegment);
  if (ownerByRole && !owners.some(owner => owner.documentNumber === digits(ownerByRole[2]))) owners.unshift({ fullName: clean(ownerByRole[1]), documentNumber: digits(ownerByRole[2]) });
  const tenant = tenantByRole ? { fullName: clean(tenantByRole[1]), documentNumber: digits(tenantByRole[2]) } : (parsePeople(tenantSegment)[0] || null);

  const dateMatch = normalized.match(/(?:comenzando el d[ií]a|a contar desde el d[ií]a|desde el d[ií]a|inicio(?: del contrato)?[:\s]+)\s*(\d{1,2})\s+de\s+(ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|SETIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE)\s+de\s+(\d{4}).+?(?:hasta el d[ií]a|hasta el|finalizando el d[ií]a|venciendo el d[ií]a|finalizando el)\s*(?:d[ií]a\s+)?(\d{1,2})\s+de\s+(ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|SETIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE)\s+de\s+(\d{4})/i)
    || normalized.match(/(?:plazo.+?)(\d{1,2})\s+(ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|SETIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE)\s+de\s+(\d{4}).+?(\d{1,2})\s+de\s+(ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|SETIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE)\s+de\s+(\d{4})/i);
  const durationMatch = normalized.match(/plazo.{0,180}?(?:\((\d+)\)|(\d+))\s*meses/i);
  const amountMatch = normalized.match(/cuotas?\s+mensuales?.{0,80}?\$\s*([\d.,]+)/i)
    || normalized.match(/suma mensual de\s*\$\s*([\d.,]+)/i)
    || normalized.match(/canon mensual.{0,40}?\$\s*([\d.,]+)/i)
    || normalized.match(/precio inicial.{0,80}?\$\s*([\d.,]+)/i)
    || normalized.match(/alquiler total.{0,80}?\$\s*([\d.,]+)/i);
  const depositMatch = normalized.match(/dep[oó]sito de garant[ií]a.+?\$\s*([\d.,]+)/i);
  const cbuMatch = normalized.match(/CBU(?:\s+[A-Za-zÀ-ÿ]+){0,4}\s*([\d\s]{22,30})/i);
  const bankMatch = normalized.match(/Banco\s+([A-Za-zÀ-ÿ ]+?)(?:\s+seg[uú]n|\.|,|\s+-)/i);
  const dueRangeMatch = normalized.match(/entre (?:los d[ií]as )?(?:el )?(\d{1,2})\s*(?:y|al|-)\s*(\d{1,2})\s+de cada mes/i);
  const dueDayMatch = normalized.match(/(?:d[ií]a|hasta el|vencimiento).{0,30}\b(\d{1,2})\b.{0,30}(?:de cada mes|mensual)/i);
  const frequency = /CUATRIMESTRAL/i.test(normalized) ? 4 : /TRIMESTRAL/i.test(normalized) ? 3 : /SEMESTRAL/i.test(normalized) ? 6 : /ANUAL/i.test(normalized) ? 12 : null;
  const index = /\bIPC\b/i.test(normalized) ? 'IPC' : /\bICL\b/i.test(normalized) ? 'ICL' : null;
  const fixedPercentage = normalized.match(/(?:aumento|ajuste|incremento).{0,80}?(\d{1,3}(?:,\d+)?)\s*%/i);
  const adjustmentType = index || (fixedPercentage ? 'FIXED_PERCENTAGE' : (/acuerdo de partes|manual/i.test(normalized) ? 'MANUAL' : null));
  const ipcLagMonths = /ipc.{0,80}(?:dos|2)\s+mes(?:es)?\s+(?:de\s+)?(?:rezago|atraso)|(?:rezago|atraso).{0,80}(?:dos|2)\s+mes(?:es)?/i.test(normalized) ? 2 : /ipc.{0,80}(?:un|1)\s+mes\s+(?:de\s+)?(?:rezago|atraso)|(?:rezago|atraso).{0,80}(?:un|1)\s+mes/i.test(normalized) ? 1 : 0;
  const residential = /destinad[oa].{0,60}vivienda|destino habitacional|uso habitacional/i.test(normalized);
  const guaranteeCompany = normalized.match(/(?:GARANT[IÍ]A SEGURA SRL|FIADOR).{0,100}?\(([^)]+)\)/i)?.[1] || (/GARANTIA YA/i.test(normalized) ? 'Garantía YA' : null);
  const hasSurety = /seguro de cauci[oó]n|p[oó]liza de cauci[oó]n|GARANT[IÍ]A SEGURA SRL/i.test(normalized);
  const hasPropertyGuarantee = /garant[ií]a propietaria|t[ií]tulo de propiedad/i.test(normalized);
  const lateFeeFixed = normalized.match(/(?:punitorio|mora|moratorio).{0,100}?(\d+(?:,\d+)?)\s*%\s*(?:diario|por d[ií]a)/i);
  const lateFeeBank = /tasa activa|banco naci[oó]n/i.test(normalized);
  const prepaidMatch = normalized.match(/(?:alquiler|canon).{0,80}(?:adelantad|anticipad).{0,80}(\d{1,2})\s+mes/i);
  const vatMatch = normalized.match(/IVA.{0,40}?(\d{1,2}(?:,\d+)?)\s*%/i);
  const serviceTypes = [
    ['WATER', /agua|aysa/i],
    ['ELECTRICITY', /electricidad|luz|edenor|edesur/i],
    ['GAS', /\bgas\b|metrogas/i],
    ['EXPENSES', /expensas/i],
    ['MUNICIPAL_TAX', /abl|municipal|impuesto inmobiliario/i],
    ['INSURANCE', /seguro contra incendio|seguro/i],
    ['INTERNET', /internet/i]
  ];
  const recurringCharges = serviceTypes.filter(([,regex]) => regex.test(normalized)).map(([type]) => ({ type, frequency: 'MONTHLY', responsibleParty: 'TENANT', calculationType: 'VARIABLE', estimatedAmount: null }));

  let startDate = null, endDate = null;
  if (dateMatch) {
    startDate = iso(dateMatch[1], dateMatch[2], dateMatch[3]);
    endDate = iso(dateMatch[4], dateMatch[5], dateMatch[6]);
  }
  const durationMonths = Number(durationMatch?.[1] || durationMatch?.[2] || 0);
  const yearsInFilename = [...filename.matchAll(/\b(20\d{2})\b/g)].map(m => m[1]);
  if (startDate && yearsInFilename.length && !yearsInFilename.includes(startDate.slice(0,4))) warnings.push(`El archivo menciona ${yearsInFilename.join('/')} pero la vigencia comienza en ${startDate.slice(0,4)}.`);
  if (startDate) {
    const clauseYears = [...normalized.matchAll(/(?:meses?|ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE)\s+(?:de|del)\s+(20\d{2})/gi)].map(m => m[1]);
    if (clauseYears.some(year => year !== startDate.slice(0,4))) warnings.push('Hay años contradictorios dentro de las cláusulas del contrato.');
  }
  if (guaranteeCompany && !/respaldar|argenprop/i.test(guaranteeCompany)) warnings.push(`La garantía es ${guaranteeCompany}; no coincide con Respaldar o Argenprop.`);
  if (!address) warnings.push('No se pudo identificar la propiedad.');
  if (!tenant) warnings.push('No se pudo identificar al inquilino.');
  if (!owners.length) warnings.push('No se pudo identificar al propietario.');
  if (!startDate || !endDate || !durationMonths) warnings.push('La vigencia del contrato está incompleta.');
  if (!amountMatch) warnings.push('No se pudo identificar el canon inicial.');

  const baseParsed = {
    address,
    propertyType: /\bLOCAL\b/i.test(filename + ' ' + normalized.slice(0,1000)) ? 'Local' : /\bCASA\b/i.test(filename) ? 'Casa' : 'Departamento',
    rentalType: residential ? 'Residencial' : /destinad[oa].{0,60}comercial|actividad comercial|local comercial/i.test(normalized) ? 'Comercial' : 'Otro',
    addressComponents: parseAddressComponents(address),
    owners,
    tenant,
    tenants: tenant ? [tenant] : [],
    startDate,
    endDate,
    durationMonths,
    initialAmount: amountMatch ? moneyValue(amountMatch[1]) : null,
    depositAmount: depositMatch ? moneyValue(depositMatch[1]) : null,
    currency: 'ARS',
    paymentPeriodStartDay: Number(dueRangeMatch?.[1] || '') || null,
    paymentPeriodEndDay: Number(dueRangeMatch?.[2] || dueDayMatch?.[1] || 10),
    adjustmentFrequencyMonths: frequency,
    adjustmentIndex: index,
    adjustmentType,
    adjustmentValuePct: fixedPercentage ? Number(fixedPercentage[1].replace(',','.')) : null,
    ipcLagMonths,
    paymentDueDay: Number(dueRangeMatch?.[2] || dueDayMatch?.[1] || 10),
    bankName: bankMatch ? `Banco ${clean(bankMatch[1])}` : '',
    cbu: digits(cbuMatch?.[1] || '').slice(0,22),
    guarantee: {
      type: hasSurety ? 'Seguro de caución' : hasPropertyGuarantee ? 'Garantía propietaria' : 'Otra',
      provider: /respaldar/i.test(guaranteeCompany || '') ? 'Respaldar' : /argenprop/i.test(guaranteeCompany || '') ? 'Argenprop' : 'Otra',
      providerDetail: guaranteeCompany
    },
    lateFee: {
      type: lateFeeFixed ? 'FIXED_DAILY' : lateFeeBank ? 'BANK_ACTIVE_RATE' : 'NONE',
      dailyPercentage: lateFeeFixed ? Number(lateFeeFixed[1].replace(',','.')) : null,
      bankRateMultiplier: lateFeeBank ? 1 : null,
      startsFrom: /primer d[ií]a del mes/i.test(normalized) ? 'FIRST_DAY_OF_MONTH' : 'AFTER_DUE_DATE',
      applyByDefault: false
    },
    paymentTerms: {
      gracePeriodDays: null,
      discountPeriodDays: null,
      prepaidRentMonths: prepaidMatch ? Number(prepaidMatch[1]) : null,
      prepaidThroughDate: null,
      specialConditions: null
    },
    vat: {
      applicable: Boolean(vatMatch),
      percentage: vatMatch ? Number(vatMatch[1].replace(',','.')) : null
    },
    initialPayments: [
      depositMatch ? { type: 'DEPOSIT', amount: moneyValue(depositMatch[1]), currency: 'ARS' } : null,
      prepaidMatch ? { type: 'PREPAID_RENT', amount: null, currency: 'ARS', prepaidMonths: Number(prepaidMatch[1]) } : null
    ].filter(Boolean),
    recurringCharges,
    alias: [address, tenant?.fullName?.split(/\s+/).slice(-1)[0], startDate?.slice(0,4)].filter(Boolean).join(' · '),
    extraction: {
      address: field(address, addressMatch?.[0] || filenameAddress, address ? 0.8 : 0.2),
      tenant: field(tenant?.fullName || null, tenantSegment, tenant ? 0.75 : 0.2),
      owners: field(owners.length ? owners.map(owner => owner.fullName).join(', ') : null, ownerSegment, owners.length ? 0.75 : 0.2),
      startDate: field(startDate, dateMatch?.[0], startDate ? 0.85 : 0.2),
      endDate: field(endDate, dateMatch?.[0], endDate ? 0.85 : 0.2),
      initialAmount: field(amountMatch ? moneyValue(amountMatch[1]) : null, amountMatch?.[0], amountMatch ? 0.75 : 0.2),
      adjustmentType: field(adjustmentType, normalized.match(/.{0,40}\b(?:IPC|ICL|CUATRIMESTRAL|TRIMESTRAL|SEMESTRAL|ANUAL)\b.{0,40}/i)?.[0], adjustmentType ? 0.7 : 0.2)
    }
  };
  const missingFields = describeMissingFields(baseParsed);
  const required = [address, tenant, owners.length, startDate, endDate, durationMonths, amountMatch].filter(Boolean).length;
  return {
    ...baseParsed,
    confidence: roundConfidence(required / 7),
    missingFields,
    warnings
  };
}

async function resolveImportDraft(db, parsed) {
  const propertyCandidates = await findPropertyCandidates(db, parsed);
  const ownerResolutions = [];
  for (const owner of parsed.owners || []) ownerResolutions.push(await findPersonCandidates(db, owner));
  const tenantResolutions = [];
  for (const tenant of parsed.tenants?.length ? parsed.tenants : (parsed.tenant ? [parsed.tenant] : [])) tenantResolutions.push(await findPersonCandidates(db, tenant));
  const property = resolutionStatus(propertyCandidates);
  return {
    property: {
      status: property,
      detected: parsed.addressComponents || parseAddressComponents(parsed.address),
      candidates: propertyCandidates
    },
    owners: ownerResolutions,
    tenants: tenantResolutions
  };
}

function resolutionStatus(candidates) {
  if (!candidates.length) return 'NO_MATCH';
  if (candidates.length === 1 && candidates[0].match === 'EXACT_MATCH') return 'EXACT_MATCH';
  if (candidates.length === 1) return 'PROBABLE_MATCH';
  return 'AMBIGUOUS_MATCH';
}

async function findPropertyCandidates(db, parsed) {
  if (!parsed.address) return [];
  const detected = parsed.addressComponents || parseAddressComponents(parsed.address);
  const { rows } = await db.query(`SELECT id,code,address,normalized_address,street_number,floor,unit_label,property_type,status FROM properties ORDER BY address LIMIT 300`);
  return rows.map(row => {
    const stored = {
      streetNumber: row.street_number || parseAddressComponents(row.address).streetNumber,
      floor: row.floor || parseAddressComponents(row.address).floor,
      unit: row.unit_label || parseAddressComponents(row.address).unit
    };
    const numberMatch = !detected.streetNumber || !stored.streetNumber || detected.streetNumber === stored.streetNumber;
    const floorMatch = !detected.floor || !stored.floor || normalizeAddress(detected.floor) === normalizeAddress(stored.floor);
    const unitMatch = !detected.unit || !stored.unit || normalizeAddress(detected.unit) === normalizeAddress(stored.unit);
    const score = similarity(parsed.address, row.address);
    const critical = numberMatch && floorMatch && unitMatch;
    const match = score > 0.94 && critical ? 'EXACT_MATCH' : score > 0.72 && critical ? 'PROBABLE_MATCH' : null;
    return { id: row.id, code: row.code, address: row.address, propertyType: row.property_type, status: row.status, score: roundConfidence(score), match, critical };
  }).filter(candidate => candidate.match).sort((a,b) => b.score - a.score).slice(0,5);
}

async function findPersonCandidates(db, person) {
  const detected = { fullName: person?.fullName || '', documentNumber: person?.documentNumber || '' };
  if (!detected.fullName && !detected.documentNumber) return { detected, status: 'NO_MATCH', candidates: [] };
  const params = [];
  let sql = 'SELECT id,full_name,document_type,document_number,email,phone,person_kind FROM persons WHERE ';
  if (detected.documentNumber) {
    params.push(detected.documentNumber);
    sql += 'document_number=$1';
  } else {
    params.push(`%${detected.fullName.split(/\s+/).filter(Boolean).join('%')}%`);
    sql += 'full_name ILIKE $1';
  }
  const exact = (await db.query(sql, params)).rows.map(row => ({ ...row, match: 'EXACT_MATCH', score: 1 }));
  if (exact.length) return { detected, status: exact.length === 1 ? 'EXACT_MATCH' : 'AMBIGUOUS_MATCH', candidates: exact };
  const { rows } = await db.query('SELECT id,full_name,document_type,document_number,email,phone,person_kind FROM persons ORDER BY full_name LIMIT 300');
  const candidates = rows.map(row => ({ ...row, score: roundConfidence(similarity(detected.fullName, row.full_name)), match: similarity(detected.fullName, row.full_name) > 0.78 ? 'PROBABLE_MATCH' : null }))
    .filter(candidate => candidate.match).sort((a,b) => b.score - a.score).slice(0,5);
  return { detected, status: resolutionStatus(candidates), candidates };
}

function buildImportDraft(parsed, text, resolution) {
  const missingFields = describeMissingFields(parsed);
  return {
    kind: 'CONTRACT_IMPORT',
    stage: 'DRAFT',
    parsed: { ...parsed, missingFields },
    extracted_text: text,
    extraction: parsed.extraction || {},
    entity_resolution: resolution,
    missing_fields: missingFields,
    blocking_fields: missingFields,
    warnings: parsed.warnings || [],
    decisions: {},
    preview: buildRentPreview(parsed)
  };
}

function buildRentPreview(parsed) {
  if (!parsed.startDate || !parsed.durationMonths || parsed.initialAmount == null) return [];
  const months = Math.min(Number(parsed.durationMonths), 12);
  return Array.from({ length: months }, (_, index) => {
    const monthDate = addMonths(parsed.startDate, index);
    const period = monthDate.slice(0,7);
    const hasAdjustment = Boolean(parsed.adjustmentFrequencyMonths && index >= parsed.adjustmentFrequencyMonths && index % parsed.adjustmentFrequencyMonths === 0);
    return {
      period,
      amount: hasAdjustment && ['IPC','ICL'].includes(parsed.adjustmentType || parsed.adjustmentIndex) ? null : parsed.initialAmount,
      currency: parsed.currency || 'ARS',
      note: hasAdjustment && ['IPC','ICL'].includes(parsed.adjustmentType || parsed.adjustmentIndex) ? `Pendiente ${parsed.adjustmentType || parsed.adjustmentIndex}` : null
    };
  });
}

async function importParsedContract(db, file, sha256, text, parsed, decisions = {}) {
  const settings = await allSettings(db);
  const client = await db.connect();
  await client.query('BEGIN');
  try {
    const created = { personIds: [], propertyIds: [], contractIds: [], documentIds: [] };
    const getPerson = async (person, selectedId = null) => {
      let row = selectedId ? (await client.query('SELECT * FROM persons WHERE id=$1',[selectedId])).rows[0] : null;
      if (!row && person.documentNumber) row = (await client.query('SELECT * FROM persons WHERE document_number=$1',[person.documentNumber])).rows[0];
      if (!row) {
        const id=uid();
        row=(await client.query(`INSERT INTO persons(id,full_name,document_number,person_kind,country,province,is_owner)
          VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[id,person.fullName,person.documentNumber || null,person.personKind || 'PERSON','Argentina','CABA',Boolean(person.isOwner)])).rows[0];
        created.personIds.push(row.id);
      }
      return row;
    };
    const ownerRows=[]; for (let index = 0; index < (parsed.owners || []).length; index += 1) ownerRows.push(await getPerson({...parsed.owners[index],isOwner:true}, decisions.ownerIds?.[index] || null));
    const parsedTenants = parsed.tenants?.length ? parsed.tenants : [parsed.tenant].filter(Boolean);
    const tenantRows=[]; for (let index = 0; index < parsedTenants.length; index += 1) tenantRows.push(await getPerson(parsedTenants[index], decisions.tenantIds?.[index] || null));
    const tenant = tenantRows[0];
    const normalizedAddress = normalizeAddress(parsed.address);
    let property = decisions.propertyId ? (await client.query('SELECT * FROM properties WHERE id=$1',[decisions.propertyId])).rows[0] : null;
    if (!property) property = (await client.query('SELECT * FROM properties WHERE normalized_address=$1',[normalizedAddress])).rows[0];
    if (!property) {
      const id = uid();
      const next=Number((await client.query('SELECT COUNT(*) total FROM properties')).rows[0].total)+1;
      const components = parsed.addressComponents || parseAddressComponents(parsed.address);
      property=(await client.query(`INSERT INTO properties(id,code,address,normalized_address,property_type,status,country,province,city,neighborhood,street,street_number,floor,unit_label)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[id,`INM-${String(next).padStart(3,'0')}`,parsed.address,normalizedAddress,parsed.propertyType,'Alquilada',
        components.country || 'Argentina',components.province || 'CABA',components.city || null,components.neighborhood || null,components.street || null,components.streetNumber || null,components.floor || null,components.unit || null])).rows[0];
      created.propertyIds.push(property.id);
    }
    const ownership = Number((100 / Math.max(ownerRows.length, 1)).toFixed(2));
    for (let index = 0; index < ownerRows.length; index += 1) {
      const percentage = index === ownerRows.length - 1 ? Number((100 - ownership * (ownerRows.length - 1)).toFixed(2)) : ownership;
      await client.query('INSERT INTO property_owners(property_id,person_id,ownership_percentage) VALUES ($1,$2,$3) ON CONFLICT (property_id,person_id) DO UPDATE SET ownership_percentage=COALESCE(property_owners.ownership_percentage,excluded.ownership_percentage)',[property.id,ownerRows[index].id,percentage]);
      await client.query('UPDATE persons SET is_owner=true,updated_at=now() WHERE id=$1',[ownerRows[index].id]);
    }

    const documentId = uid();
    await client.query('INSERT INTO documents(id,filename,absolute_path,sha256,property_id,extracted_text) VALUES ($1,$2,$3,$4,$5,$6)',[documentId,path.basename(file),path.resolve(file),sha256,property.id,text]);
    created.documentIds.push(documentId);
    const contractId = uid();
    created.contractIds.push(contractId);
    const nextContract=Number((await client.query('SELECT COUNT(*) total FROM contracts')).rows[0].total)+1;
    const status = parsed.warnings.length ? 'Revisión' : 'Activo';
    await client.query(`INSERT INTO contracts(id,code,alias,property_id,tenant_id,rental_type,duration_months,start_date,end_date,initial_amount,currency,
      adjustment_frequency_months,adjustment_index,payment_due_day,payment_period_start_day,payment_period_end_day,management_fee_pct,deposit_amount,bank_name,cbu,status,source_document_id,
      adjustment_type,adjustment_value_pct,ipc_lag_months,vat_applicable,vat_percentage,late_fee_json,payment_terms_json,import_snapshot_json)
      VALUES (${Array.from({length:30},(_,index)=>`$${index+1}`).join(',')})`,[contractId,`CONT-${parsed.startDate.slice(0,4)}-${String(nextContract).padStart(3,'0')}`,parsed.alias || null,
      property.id, tenant.id, parsed.rentalType, parsed.durationMonths, parsed.startDate, parsed.endDate, parsed.initialAmount, parsed.currency,
      parsed.adjustmentFrequencyMonths, parsed.adjustmentIndex, parsed.paymentDueDay, parsed.paymentPeriodStartDay || null, parsed.paymentPeriodEndDay || parsed.paymentDueDay || null, Number(settings.default_management_fee_pct || 3),
      parsed.depositAmount,parsed.bankName||settings.bank_name,parsed.cbu||settings.cbu,status,documentId,
      parsed.adjustmentType || parsed.adjustmentIndex || 'MANUAL', parsed.adjustmentValuePct || null, Number(parsed.ipcLagMonths || 0), Boolean(parsed.vat?.applicable), parsed.vat?.percentage || null,
      JSON.stringify(parsed.lateFee || {}), JSON.stringify(parsed.paymentTerms || {}), JSON.stringify({ parsed, decisions })]);
    await client.query('UPDATE documents SET contract_id=$1 WHERE id=$2',[contractId,documentId]);
    for (const owner of ownerRows) await client.query('INSERT INTO contract_owners(contract_id,person_id) VALUES ($1,$2)',[contractId,owner.id]);
    for (let index = 0; index < tenantRows.length; index += 1) await client.query('INSERT INTO contract_tenants(contract_id,person_id,snapshot_name,snapshot_document) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',[contractId,tenantRows[index].id,parsedTenants[index]?.fullName || tenantRows[index].full_name,parsedTenants[index]?.documentNumber || tenantRows[index].document_number]);
    await client.query('INSERT INTO guarantees(id,contract_id,guarantee_type,provider,provider_detail) VALUES ($1,$2,$3,$4,$5)',[uid(),contractId,parsed.guarantee.type,parsed.guarantee.provider,parsed.guarantee.providerDetail]);
    for (const payment of parsed.initialPayments || []) await client.query('INSERT INTO initial_payments(id,contract_id,payment_type,amount,currency,installments_count,prepaid_months,prepaid_through_date,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[uid(),contractId,payment.type, payment.amount ?? null, payment.currency || parsed.currency || 'ARS', payment.installmentsCount || null, payment.prepaidMonths || null, payment.prepaidThroughDate || null, payment.notes || null]);
    for (const charge of parsed.recurringCharges || []) await client.query('INSERT INTO recurring_charges(id,contract_id,charge_type,custom_name,frequency,responsible_party,calculation_type,value,estimated_amount,currency,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[uid(),contractId,charge.type || 'OTHER',charge.customName || null,charge.frequency || null,charge.responsibleParty || null,charge.calculationType || null,charge.value || null,charge.estimatedAmount || null,charge.currency || parsed.currency || 'ARS',charge.notes || null]);
    for (let i = 0; i < parsed.durationMonths; i += 1) {
      const monthDate = addMonths(parsed.startDate, i);
      const period = monthDate.slice(0,7);
      const dueDate = `${period}-${String(Math.min(parsed.paymentDueDay, 28)).padStart(2,'0')}`;
      const pending = Boolean(parsed.adjustmentFrequencyMonths && i >= parsed.adjustmentFrequencyMonths);
      await client.query('INSERT INTO installments(id,contract_id,period,due_date,expected_amount,currency,adjustment_pending) VALUES ($1,$2,$3,$4,$5,$6,$7)',[uid(),contractId,period,dueDate,parsed.initialAmount,parsed.currency,pending]);
    }
    await client.query('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES ($1,$2,$3,$4,$5)',[uid(),'contract',contractId,'imported',{filename:path.basename(file),warnings:parsed.warnings}]);
    const result = { contractId, propertyId: property.id, tenantId: tenant.id, tenantIds: tenantRows.map(row => row.id), ownerIds: ownerRows.map(row => row.id), documentId, status, created };
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

function hydrateParsedFromManualReview(baseParsed, input) {
  const owner = {
    fullName: clean(input.owner_full_name || baseParsed.owners?.[0]?.fullName),
    documentNumber: digits(input.owner_document_number || baseParsed.owners?.[0]?.documentNumber)
  };
  const tenant = {
    fullName: clean(input.tenant_full_name || baseParsed.tenant?.fullName),
    documentNumber: digits(input.tenant_document_number || baseParsed.tenant?.documentNumber)
  };
  const owners = input.owners?.length
    ? input.owners.map(item => ({ fullName: clean(item.fullName || item.full_name), documentNumber: digits(item.documentNumber || item.document_number), personKind: item.personKind || item.person_kind || 'PERSON' })).filter(item => item.fullName || item.documentNumber)
    : (baseParsed.owners?.length ? baseParsed.owners : (owner.fullName && owner.documentNumber ? [owner] : []));
  const tenants = input.tenants?.length
    ? input.tenants.map(item => ({ fullName: clean(item.fullName || item.full_name), documentNumber: digits(item.documentNumber || item.document_number), personKind: item.personKind || item.person_kind || 'PERSON' })).filter(item => item.fullName || item.documentNumber)
    : (baseParsed.tenants?.length ? baseParsed.tenants : (tenant.fullName && tenant.documentNumber ? [tenant] : []));
  const startDate = input.start_date || baseParsed.startDate || null;
  const durationMonths = Number(input.duration_months || baseParsed.durationMonths || 0) || null;
  const endDate = input.end_date || baseParsed.endDate || (startDate && durationMonths ? buildEndDate(startDate, durationMonths) : null);
  const address = clean(input.address || baseParsed.address);
  return {
    ...baseParsed,
    address,
    addressComponents: parseAddressComponents(address),
    alias: clean(input.alias || baseParsed.alias),
    propertyType: input.property_type || baseParsed.propertyType || 'Departamento',
    rentalType: input.rental_type || baseParsed.rentalType || 'Residencial',
    owners,
    tenant: tenants[0] || null,
    tenants,
    startDate,
    endDate,
    durationMonths,
    initialAmount: input.initial_amount != null && input.initial_amount !== '' ? Number(input.initial_amount) : baseParsed.initialAmount,
    depositAmount: input.deposit_amount != null && input.deposit_amount !== '' ? Number(input.deposit_amount) : baseParsed.depositAmount,
    currency: input.currency || baseParsed.currency || 'ARS',
    adjustmentFrequencyMonths: input.adjustment_frequency_months != null && input.adjustment_frequency_months !== '' ? Number(input.adjustment_frequency_months) : baseParsed.adjustmentFrequencyMonths,
    adjustmentIndex: input.adjustment_index || baseParsed.adjustmentIndex || null,
    adjustmentType: input.adjustment_type || baseParsed.adjustmentType || input.adjustment_index || baseParsed.adjustmentIndex || 'MANUAL',
    adjustmentValuePct: input.adjustment_value_pct != null && input.adjustment_value_pct !== '' ? Number(input.adjustment_value_pct) : baseParsed.adjustmentValuePct,
    ipcLagMonths: input.ipc_lag_months != null && input.ipc_lag_months !== '' ? Number(input.ipc_lag_months) : (baseParsed.ipcLagMonths || 0),
    paymentPeriodStartDay: input.payment_period_start_day != null && input.payment_period_start_day !== '' ? Number(input.payment_period_start_day) : baseParsed.paymentPeriodStartDay,
    paymentPeriodEndDay: input.payment_period_end_day != null && input.payment_period_end_day !== '' ? Number(input.payment_period_end_day) : baseParsed.paymentPeriodEndDay,
    paymentDueDay: input.payment_due_day != null && input.payment_due_day !== '' ? Number(input.payment_due_day) : (baseParsed.paymentDueDay || 10),
    bankName: clean(input.bank_name || baseParsed.bankName),
    cbu: digits(input.cbu || baseParsed.cbu || '').slice(0,22),
    guarantee: {
      type: input.guarantee_type || baseParsed.guarantee?.type || 'Otra',
      provider: input.guarantee_provider || baseParsed.guarantee?.provider || 'Otra',
      providerDetail: clean(input.guarantee_provider_detail || baseParsed.guarantee?.providerDetail)
    },
    lateFee: {
      ...(baseParsed.lateFee || {}),
      type: input.late_fee_type || baseParsed.lateFee?.type || 'NONE',
      dailyPercentage: input.late_fee_daily_pct != null && input.late_fee_daily_pct !== '' ? Number(input.late_fee_daily_pct) : baseParsed.lateFee?.dailyPercentage,
      applyByDefault: Boolean(input.late_fee_apply_by_default)
    },
    paymentTerms: {
      ...(baseParsed.paymentTerms || {}),
      prepaidRentMonths: input.prepaid_rent_months != null && input.prepaid_rent_months !== '' ? Number(input.prepaid_rent_months) : baseParsed.paymentTerms?.prepaidRentMonths
    },
    vat: {
      applicable: Boolean(input.vat_applicable),
      percentage: input.vat_percentage != null && input.vat_percentage !== '' ? Number(input.vat_percentage) : baseParsed.vat?.percentage
    }
  };
}

async function importPdf(db, file) {
  const absolute = path.resolve(file);
  const ext = path.extname(file).toLowerCase();
  if (ext !== '.pdf') throw new Error('Solo se aceptan archivos PDF');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  if ((await db.query('SELECT id FROM documents WHERE sha256=$1',[sha256])).rowCount) return { status:'Omitido',filename:path.basename(file),reason:'Ya fue importado' };
  const previous = (await db.query(`SELECT id,status,error_message,result_json,created_at FROM imports WHERE sha256=$1 AND status IN ('Revisión','Error','Procesado','Descartado','Revertido') ORDER BY created_at DESC LIMIT 1`,[sha256])).rows[0];
  if (previous) return { status:'Omitido',filename:path.basename(file),reason:`Ya fue analizado previamente (${previous.status}).`,importId:previous.id };
  const importId = uid();
  try {
    const text = await extractPdfText(absolute);
    const parsed = parseContractText(text, path.basename(file));
    const resolution = await resolveImportDraft(db, parsed);
    const draft = buildImportDraft(parsed, text, resolution);
    const errorMessage = draft.blocking_fields.length ? summarizeMissingFields(draft.blocking_fields) : null;
    await db.query('INSERT INTO imports(id,filename,absolute_path,sha256,status,confidence,warnings_json,result_json,error_message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[
      importId,
      path.basename(file),
      absolute,
      sha256,
      'Revisión',
      parsed.confidence,
      JSON.stringify([...(parsed.warnings || []), ...draft.blocking_fields.map(field => field.message)]),
      JSON.stringify(draft),
      errorMessage
    ]);
    return { id: importId, filename: path.basename(file), status: 'Revisión', confidence: parsed.confidence, warnings: parsed.warnings, missingFields: draft.blocking_fields, draft: true };
  } catch (error) {
    await db.query('INSERT INTO imports(id,filename,absolute_path,sha256,status,error_message) VALUES ($1,$2,$3,$4,$5,$6)',[importId,path.basename(file),absolute,sha256,'Error',error.message]);
    return { id: importId, filename: path.basename(file), status: 'Error', error: error.message };
  }
}

function isInsideDirectory(file,directory){
  const relative=path.relative(path.resolve(directory),path.resolve(file));
  return Boolean(relative)&&!relative.startsWith('..')&&!path.isAbsolute(relative);
}

function completionResult(row={}) {
  return row.result_json?.completion_result || row.result_json?.completionResult || {};
}

function createdIds(result={},key){
  return Array.isArray(result.created?.[key]) ? result.created[key].filter(Boolean) : [];
}

async function canDeleteImportedProperty(client,propertyId){
  const refs=(await client.query(`SELECT
    (SELECT COUNT(*)::int FROM contracts WHERE property_id=$1) contracts,
    (SELECT COUNT(*)::int FROM documents WHERE property_id=$1) documents,
    (SELECT COUNT(*)::int FROM incidents WHERE property_id=$1) incidents,
    (SELECT COUNT(*)::int FROM ledger_entries WHERE property_id=$1) ledger`,[propertyId])).rows[0];
  return !refs.contracts&&!refs.documents&&!refs.incidents&&!refs.ledger;
}

async function canDeleteImportedPerson(client,personId){
  const refs=(await client.query(`SELECT
    (SELECT COUNT(*)::int FROM contracts WHERE tenant_id=$1) tenant_contracts,
    (SELECT COUNT(*)::int FROM contract_tenants WHERE person_id=$1) contract_tenants,
    (SELECT COUNT(*)::int FROM contract_owners WHERE person_id=$1) contract_owners,
    (SELECT COUNT(*)::int FROM property_owners WHERE person_id=$1) property_owners`,[personId])).rows[0];
  return !refs.tenant_contracts&&!refs.contract_tenants&&!refs.contract_owners&&!refs.property_owners;
}

async function purgeMissingImportFile(db,row,directory){
  const result=completionResult(row),contractId=result.contractId,documentId=result.documentId,summary={importId:row.id,filename:row.filename,contractId,documentId,deleted:{payments:0,installments:0,contracts:0,documents:0,imports:0,properties:0,persons:0},kept:{properties:[],persons:[]}};
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    if(contractId){
      await client.query(`DELETE FROM payments WHERE installment_id IN (SELECT id FROM installments WHERE contract_id=$1)`,[contractId]).then(res=>{summary.deleted.payments=res.rowCount;});
      await client.query('DELETE FROM installments WHERE contract_id=$1',[contractId]).then(res=>{summary.deleted.installments=res.rowCount;});
      await client.query('DELETE FROM initial_payments WHERE contract_id=$1',[contractId]);
      await client.query('DELETE FROM recurring_charges WHERE contract_id=$1',[contractId]);
      await client.query('DELETE FROM guarantees WHERE contract_id=$1',[contractId]);
      await client.query('DELETE FROM contract_tenants WHERE contract_id=$1',[contractId]);
      await client.query('DELETE FROM contract_owners WHERE contract_id=$1',[contractId]);
      await client.query('DELETE FROM documents WHERE id=$1 OR contract_id=$2',[documentId,contractId]).then(res=>{summary.deleted.documents+=res.rowCount;});
      await client.query('DELETE FROM contracts WHERE id=$1',[contractId]).then(res=>{summary.deleted.contracts=res.rowCount;});
    }
    await client.query('DELETE FROM documents WHERE absolute_path=$1 OR id=$2',[row.absolute_path,documentId]).then(res=>{summary.deleted.documents+=res.rowCount;});
    for(const propertyId of createdIds(result,'propertyIds')){
      if(await canDeleteImportedProperty(client,propertyId)){
        await client.query('DELETE FROM property_owners WHERE property_id=$1',[propertyId]);
        await client.query('DELETE FROM properties WHERE id=$1',[propertyId]).then(res=>{summary.deleted.properties+=res.rowCount;});
      }else summary.kept.properties.push(propertyId);
    }
    for(const personId of createdIds(result,'personIds')){
      await client.query('DELETE FROM property_owners WHERE person_id=$1',[personId]);
      if(await canDeleteImportedPerson(client,personId))await client.query('DELETE FROM persons WHERE id=$1',[personId]).then(res=>{summary.deleted.persons+=res.rowCount;});
      else summary.kept.persons.push(personId);
    }
    await client.query('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES ($1,$2,$3,$4,$5)',[uid(),'import',row.id,'purged_missing_file',{...summary,directory}]);
    await client.query('DELETE FROM imports WHERE id=$1',[row.id]).then(res=>{summary.deleted.imports=res.rowCount;});
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  return summary;
}

async function purgeMissingImportFiles(db,directory){
  const tracked=(await db.query(`SELECT id,filename,absolute_path,status,result_json FROM imports WHERE absolute_path IS NOT NULL AND status IN ('Revisión','Error','Procesado','Descartado','Revertido')`)).rows;
  const purged=[];
  for(const row of tracked){
    if(!isInsideDirectory(row.absolute_path,directory))continue;
    if(fs.existsSync(row.absolute_path))continue;
    purged.push(await purgeMissingImportFile(db,row,directory));
  }
  return purged;
}

async function scanImportDirectory(db) {
  const directory = (await allSettings(db)).import_directory;
  fs.mkdirSync(directory, { recursive: true });
  const purged = await purgeMissingImportFiles(db, directory);
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.pdf')
    .map(entry => path.join(directory, entry.name));
  const results = [];
  for (const file of files) results.push(await importPdf(db, file));
  return {
    directory,
    scanned: files.length,
    imported: results.filter(r => ['Procesado','Revisión'].includes(r.status)).length,
    detected: results.filter(r => ['Procesado','Revisión'].includes(r.status)).length,
    skipped: results.filter(r => r.status === 'Omitido').length,
    purged: purged.length,
    purgedDetails: purged,
    results
  };
}

async function completeImportReview(db, importId, input) {
  const row = (await db.query('SELECT * FROM imports WHERE id=$1',[importId])).rows[0];
  if (!row) throw new Error('La importación no existe.');
  if (row.status !== 'Revisión') throw new Error('Solo se pueden completar importaciones en revisión.');
  const saved = row.result_json || {};
  const parsed = hydrateParsedFromManualReview(saved.parsed || {}, input);
  const missingFields = describeMissingFields(parsed);
  const decisions = {
    ...(saved.decisions || {}),
    propertyId: input.property_id || saved.decisions?.propertyId || null,
    ownerIds: input.owner_ids || saved.decisions?.ownerIds || [],
    tenantIds: input.tenant_ids || saved.decisions?.tenantIds || []
  };
  const resolution = await resolveImportDraft(db, parsed);
  if (missingFields.length) {
    const errorMessage = summarizeMissingFields(missingFields);
    await db.query('UPDATE imports SET result_json=$1,error_message=$2,warnings_json=$3 WHERE id=$4',[
      JSON.stringify({ ...saved, parsed: { ...parsed, missingFields }, missing_fields: missingFields, blocking_fields: missingFields, entity_resolution: resolution, decisions }),
      errorMessage,
      JSON.stringify([...(parsed.warnings || []), ...missingFields.map(field => field.message)]),
      importId
    ]);
    const error = new Error(errorMessage);
    error.details = { missingFields };
    throw error;
  }
  const result = await importParsedContract(db, row.absolute_path, row.sha256, saved.extracted_text || '', { ...parsed, warnings: parsed.warnings || [] }, decisions);
  const { missing_fields: _oldMissingFields, ...savedWithoutMissingFields } = saved;
  await db.query('UPDATE imports SET status=$1,confidence=$2,warnings_json=$3,result_json=$4,error_message=NULL WHERE id=$5',[
    'Procesado',
    roundConfidence(1),
    JSON.stringify(parsed.warnings || []),
    JSON.stringify({
      ...savedWithoutMissingFields,
      parsed: { ...parsed, missingFields: [] },
      missing_fields: [],
      blocking_fields: [],
      entity_resolution: resolution,
      decisions,
      stage: 'CONFIRMED',
      completed_manually: true,
      completed_at: new Date().toISOString(),
      completion_result: result
    }),
    importId
  ]);
  return { id: importId, status: 'Procesado', contractStatus: result.status, contractId: result.contractId };
}

module.exports = { extractPdfText, parseContractText, importPdf, scanImportDirectory, completeImportReview, describeMissingFields };
