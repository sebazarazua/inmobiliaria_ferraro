const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { uid, normalizeAddress, allSettings } = require('../../database');
const {addMonths:calendarAddMonths,shiftMonth}=require('../../lib/calendar');
const {calculateIpcAmount}=require('../ipc');
const {loadStoredSeries}=require('../ipc/store');
const {generateInstallments}=require('../rent');

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

function addMonths(dateString,count){return calendarAddMonths(dateString,count);}

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
    ...extractIpcClause(text),
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

function buildImportDraft(parsed, text, resolution, series) {
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
    preview: buildRentPreview(parsed,series)
  };
}

function extractIpcClause(text='') {
  const match=/\bIPC\b|índice de precios al consumidor/i.exec(text);
  if(!match)return {ipcClauseText:null,ipcClauseReviewRequired:false};
  const clause=text.slice(Math.max(0,match.index-160),Math.min(text.length,match.index+600));
  const mentionsLag=/rezago|atraso|último.{0,30}publicado|disponible/i.test(clause);
  const explicit=/(?:un|1)\s+mes\s+(?:de\s+)?(?:rezago|atraso)|(?:dos|2)\s+meses?\s+(?:de\s+)?(?:rezago|atraso)|(?:rezago|atraso).{0,30}(?:un|1|dos|2)\s+mes/i.test(clause);
  return {ipcClauseText:clause,ipcClauseReviewRequired:mentionsLag&&!explicit};
}
function buildRentPreview(parsed,data={series:new Map()}) {
  if(!parsed.startDate||!parsed.durationMonths||parsed.initialAmount==null)return [];
  const months=Number(parsed.durationMonths);if(!Number.isInteger(months)||months<1||months>1200)return [];
  return Array.from({length:months},(_,index)=>{
    const period=shiftMonth(parsed.startDate,index);
    try{
      const result=calculateIpcAmount({start_date:parsed.startDate,initial_amount:parsed.initialAmount,adjustment_index:parsed.adjustmentIndex,adjustment_frequency_months:parsed.adjustmentFrequencyMonths,ipc_lag_months:parsed.ipcLagMonths||0},period,data);
      return {period,amount:result.amount,currency:parsed.currency||'ARS',adjustment_pending:result.pendingOfficialData,note:result.pendingOfficialData?'Provisional · pendiente IPC oficial':null};
    }catch(error){return {period,amount:null,currency:parsed.currency||'ARS',note:error.message};}
  });
}

async function importParsedContract(db, file, sha256, text, parsed, decisions = {}, beforeCommit = null) {
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

    // Un documento conservado de un contrato eliminado se reutiliza: el hash es único y conserva su trazabilidad.
    const keptDocument = (await client.query('SELECT id,contract_id FROM documents WHERE sha256=$1 FOR UPDATE',[sha256])).rows[0];
    if (keptDocument?.contract_id) throw new Error('Ya existe un contrato asociado a este documento.');
    const documentId = keptDocument?.id || uid();
    if (keptDocument) await client.query('UPDATE documents SET filename=$1,absolute_path=$2,property_id=$3,extracted_text=$4 WHERE id=$5',[path.basename(file),path.resolve(file),property.id,text,documentId]);
    else {
      await client.query('INSERT INTO documents(id,filename,absolute_path,sha256,property_id,extracted_text) VALUES ($1,$2,$3,$4,$5,$6)',[documentId,path.basename(file),path.resolve(file),sha256,property.id,text]);
      created.documentIds.push(documentId);
    }
    const contractId = uid();
    created.contractIds.push(contractId);
    const nextContract=Number((await client.query('SELECT COUNT(*) total FROM contracts')).rows[0].total)+1;
    const status = parsed.warnings.length ? 'Revisión' : 'Activo';
    await client.query(`INSERT INTO contracts(id,code,alias,property_id,tenant_id,rental_type,duration_months,start_date,end_date,initial_amount,currency,
      adjustment_frequency_months,adjustment_index,payment_due_day,payment_period_start_day,payment_period_end_day,management_fee_pct,deposit_amount,bank_name,cbu,status,source_document_id,
      adjustment_type,adjustment_value_pct,ipc_lag_months,vat_applicable,vat_percentage,late_fee_json,payment_terms_json,import_snapshot_json,ipc_clause_text,ipc_clause_review_required)
      VALUES (${Array.from({length:32},(_,index)=>`$${index+1}`).join(',')})`,[contractId,`CONT-${parsed.startDate.slice(0,4)}-${String(nextContract).padStart(3,'0')}`,parsed.alias || null,
      property.id, tenant.id, parsed.rentalType, parsed.durationMonths, parsed.startDate, parsed.endDate, parsed.initialAmount, parsed.currency,
      parsed.adjustmentFrequencyMonths, parsed.adjustmentIndex, parsed.paymentDueDay, parsed.paymentPeriodStartDay || null, parsed.paymentPeriodEndDay || parsed.paymentDueDay || null, Number(settings.default_management_fee_pct || 3),
      parsed.depositAmount,parsed.bankName||settings.bank_name,parsed.cbu||settings.cbu,status,documentId,
      parsed.adjustmentType || parsed.adjustmentIndex || 'MANUAL', parsed.adjustmentValuePct || null, Number(parsed.ipcLagMonths || 0), Boolean(parsed.vat?.applicable), parsed.vat?.percentage || null,
      JSON.stringify(parsed.lateFee || {}), JSON.stringify(parsed.paymentTerms || {}), JSON.stringify({ parsed, decisions }),parsed.ipcClauseText||null,Boolean(parsed.ipcClauseReviewRequired)]);
    await client.query('UPDATE documents SET contract_id=$1 WHERE id=$2',[contractId,documentId]);
    for (const owner of ownerRows) await client.query('INSERT INTO contract_owners(contract_id,person_id) VALUES ($1,$2)',[contractId,owner.id]);
    for (let index = 0; index < tenantRows.length; index += 1) await client.query('INSERT INTO contract_tenants(contract_id,person_id,snapshot_name,snapshot_document) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',[contractId,tenantRows[index].id,parsedTenants[index]?.fullName || tenantRows[index].full_name,parsedTenants[index]?.documentNumber || tenantRows[index].document_number]);
    await client.query('INSERT INTO guarantees(id,contract_id,guarantee_type,provider,provider_detail) VALUES ($1,$2,$3,$4,$5)',[uid(),contractId,parsed.guarantee.type,parsed.guarantee.provider,parsed.guarantee.providerDetail]);
    for (const payment of parsed.initialPayments || []) await client.query('INSERT INTO initial_payments(id,contract_id,payment_type,amount,currency,installments_count,prepaid_months,prepaid_through_date,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[uid(),contractId,payment.type, payment.amount ?? null, payment.currency || parsed.currency || 'ARS', payment.installmentsCount || null, payment.prepaidMonths || null, payment.prepaidThroughDate || null, payment.notes || null]);
    for (const charge of parsed.recurringCharges || []) await client.query('INSERT INTO recurring_charges(id,contract_id,charge_type,custom_name,frequency,responsible_party,calculation_type,value,estimated_amount,currency,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[uid(),contractId,charge.type || 'OTHER',charge.customName || null,charge.frequency || null,charge.responsibleParty || null,charge.calculationType || null,charge.value || null,charge.estimatedAmount || null,charge.currency || parsed.currency || 'ARS',charge.notes || null]);
    await generateInstallments(client,(await client.query('SELECT * FROM contracts WHERE id=$1',[contractId])).rows[0],{reason:'contract_imported'});
    await client.query('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES ($1,$2,$3,$4,$5)',[uid(),'contract',contractId,'imported',{filename:path.basename(file),warnings:parsed.warnings}]);
    const result = { contractId, propertyId: property.id, tenantId: tenant.id, tenantIds: tenantRows.map(row => row.id), ownerIds: ownerRows.map(row => row.id), documentId, status, created };
    if (beforeCommit) await beforeCommit(client, result);
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
    ipcClauseText: baseParsed.ipcClauseText || input.ipc_clause_text || null,
    ipcClauseReviewRequired: input.ipc_clause_confirmed===true || input.ipc_clause_confirmed==='true' ? false : Boolean(baseParsed.ipcClauseReviewRequired),
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

// Serializa por contenido: dos lecturas del mismo PDF (scanner, subida o reintento) nunca crean intentos paralelos.
async function withImportLock(db, sha256, work) {
  const client = await db.connect(), key = `ferraro:import:${sha256}`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))',[key]);
    return await work();
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))',[key]).catch(() => {});
    client.release();
  }
}

// Situación de un PDF según su SHA-256. Solo 'new' se importa automáticamente; los estados
// reimportables requieren una acción explícita (subida manual o "Volver a importar").
async function classifyDocument(db, sha256) {
  const document = (await db.query(`SELECT d.id,d.filename,d.absolute_path,d.contract_id,c.code contract_code,c.status contract_status
    FROM documents d LEFT JOIN contracts c ON c.id=d.contract_id WHERE d.sha256=$1`,[sha256])).rows[0];
  const latest = (await db.query(`SELECT id,filename,absolute_path,status,error_message,result_json,created_at FROM imports
    WHERE sha256=$1 AND status<>'Omitido' ORDER BY created_at DESC LIMIT 1`,[sha256])).rows[0];
  const excluded = (await db.query('SELECT reason,created_at FROM import_exclusions WHERE sha256=$1',[sha256])).rows[0];
  const base = { sha256, importId: latest?.id || null, documentId: document?.id || null, importStatus: latest?.status || null };
  if (document?.contract_id) return { ...base, state:'linked', reimportable:false, contractId:document.contract_id, contractCode:document.contract_code, reason:`Ya existe un contrato asociado a este documento (${document.contract_code}).` };
  const processedContractId = latest?.status === 'Procesado' ? completionResult(latest).contractId : null;
  if (processedContractId) {
    const contract = (await db.query('SELECT id,code FROM contracts WHERE id=$1',[processedContractId])).rows[0];
    if (contract) return { ...base, state:'linked', reimportable:false, contractId:contract.id, contractCode:contract.code, reason:`Ya existe un contrato asociado a este documento (${contract.code}).` };
  }
  if (excluded) return { ...base, state:'excluded', reimportable:false, reason:'Este documento está excluido de las importaciones automáticas. Quitá la exclusión desde Documentos para volver a importarlo.' };
  if (latest?.status === 'Revisión') return { ...base, state:'review', reimportable:false, reason:'Este documento ya está cargado y espera revisión en Importaciones.' };
  if (['Revertido','Procesado'].includes(latest?.status) || document) return { ...base, state:'contract_deleted', reimportable:true, reason:'El contrato creado con este documento fue eliminado. Podés volver a importarlo.' };
  if (latest?.status === 'Descartado') return { ...base, state:'discarded', reimportable:true, reason:'La importación de este documento fue descartada. Podés volver a importarlo.' };
  if (latest?.status === 'Error') return { ...base, state:'failed', reimportable:true, reason:`La lectura anterior falló${latest.error_message ? `: ${latest.error_message}` : '.'} Podés reintentarla.` };
  return { ...base, state:'new', reimportable:true, reason:null };
}

async function importPdf(db, file, options = {}) {
  const absolute = path.resolve(file);
  const ext = path.extname(file).toLowerCase();
  if (ext !== '.pdf') throw new Error('Solo se aceptan archivos PDF');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  return withImportLock(db, sha256, async () => {
    const situation = await classifyDocument(db, sha256);
    const manual = options.mode === 'manual';
    if (situation.state !== 'new' && !(manual && situation.reimportable)) {
      return { status:'Omitido', filename:path.basename(file), reason:situation.reason, reasonCode:situation.state, reimportable:situation.reimportable, importId:situation.importId, contractId:situation.contractId || null, contractCode:situation.contractCode || null };
    }
    return analyzePdf(db, absolute, sha256, options.previousImportId || situation.importId || null);
  });
}

async function analyzePdf(db, absolute, sha256, previousImportId) {
  const file = absolute;
  const importId = uid();
  try {
    const text = await extractPdfText(absolute);
    const parsed = parseContractText(text, path.basename(file));
    const resolution = await resolveImportDraft(db, parsed);
    const draft = buildImportDraft(parsed, text, resolution,await loadStoredSeries(db));
    const errorMessage = draft.blocking_fields.length ? summarizeMissingFields(draft.blocking_fields) : null;
    await db.query('INSERT INTO imports(id,filename,absolute_path,sha256,status,confidence,warnings_json,result_json,error_message,previous_import_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[
      importId,
      path.basename(file),
      absolute,
      sha256,
      'Revisión',
      parsed.confidence,
      JSON.stringify([...(parsed.warnings || []), ...draft.blocking_fields.map(field => field.message)]),
      JSON.stringify(draft),
      errorMessage,
      previousImportId
    ]);
    return { id: importId, filename: path.basename(file), status: 'Revisión', confidence: parsed.confidence, warnings: parsed.warnings, missingFields: draft.blocking_fields, draft: true, previousImportId };
  } catch (error) {
    await db.query('INSERT INTO imports(id,filename,absolute_path,sha256,status,error_message,previous_import_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',[importId,path.basename(file),absolute,sha256,'Error',error.message,previousImportId]);
    return { id: importId, filename: path.basename(file), status: 'Error', error: error.message, previousImportId };
  }
}

function isInsideDirectory(file,directory){
  const relative=path.relative(path.resolve(directory),path.resolve(file));
  return Boolean(relative)&&!relative.startsWith('..')&&!path.isAbsolute(relative);
}

function completionResult(row={}) {
  return row.result_json?.completion_result || row.result_json?.completionResult || {};
}

// El scanner nunca borra datos: si un PDF registrado ya no está en la carpeta solo lo informa.
// La limpieza se hace de forma explícita desde el administrador de documentos.
function missingImportFiles(rows, directory) {
  return rows.filter(row => row.absolute_path && isInsideDirectory(row.absolute_path, directory) && !fs.existsSync(row.absolute_path))
    .map(row => ({ importId: row.id, filename: row.filename, status: row.status }));
}

async function scanImportDirectory(db) {
  const directory = (await allSettings(db)).import_directory;
  fs.mkdirSync(directory, { recursive: true });
  const tracked = (await db.query(`SELECT DISTINCT ON (absolute_path) id,filename,absolute_path,status FROM imports WHERE absolute_path IS NOT NULL ORDER BY absolute_path,created_at DESC`)).rows;
  const missing = missingImportFiles(tracked, directory);
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
    purged: 0,
    missing: missing.length,
    missingDetails: missing,
    results
  };
}

async function completeImportReview(db, importId, input) {
  const found = (await db.query('SELECT sha256 FROM imports WHERE id=$1',[importId])).rows[0];
  if (!found) throw new Error('La importación no existe.');
  return withImportLock(db, found.sha256 || importId, () => completeLockedImportReview(db, importId, input));
}

async function completeLockedImportReview(db, importId, input) {
  const row = (await db.query('SELECT * FROM imports WHERE id=$1',[importId])).rows[0];
  if (!row) throw new Error('La importación no existe.');
  if (row.status !== 'Revisión') throw new Error('Solo se pueden completar importaciones en revisión.');
  if (row.sha256) {
    const situation = await classifyDocument(db, row.sha256);
    if (situation.state === 'linked') throw new Error(situation.reason);
  }
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
  const { missing_fields: _oldMissingFields, ...savedWithoutMissingFields } = saved;
  // El contrato y el cierre de la importación se confirman en la misma transacción.
  const result = await importParsedContract(db, row.absolute_path, row.sha256, saved.extracted_text || '', { ...parsed, warnings: parsed.warnings || [] }, decisions, (client, result) => client.query('UPDATE imports SET status=$1,confidence=$2,warnings_json=$3,result_json=$4,error_message=NULL WHERE id=$5',[
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
  ]));
  return { id: importId, status: 'Procesado', contractStatus: result.status, contractId: result.contractId };
}

module.exports = { buildRentPreview, extractIpcClause, extractPdfText, parseContractText, importPdf, classifyDocument, withImportLock, scanImportDirectory, completeImportReview, describeMissingFields };
