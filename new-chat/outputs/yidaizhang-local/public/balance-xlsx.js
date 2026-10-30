/* Browser-only OOXML export. No network requests or runtime dependencies. */
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const encoder = new TextEncoder();

// An inline string is always text, even when a value begins with =, +, - or @.
function xml(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF\uFFFE\uFFFF]/gu, '')
    .replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[char]));
}

function column(index) {
  let result = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result;
  return result;
}

function textCell(col, row, value, style) {
  return `<c r="${column(col)}${row}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function emptyCell(col, row, style) {
  return `<c r="${column(col)}${row}" s="${style}"/>`;
}

function numericCell(col, row, value) {
  const amount = value ?? 0;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new TypeError(`Invalid numeric amount at ${column(col)}${row}`);
  return `<c r="${column(col)}${row}" s="10"><v>${Object.is(amount, -0) ? 0 : amount}</v></c>`;
}

function rowXml(index, height, cells) {
  return `<row r="${index}" ht="${height}" customHeight="1">${cells.join('')}</row>`;
}

function mergedRow(index, height, value, count, style, remainderStyle = style) {
  return rowXml(index, height, Array.from({length: count}, (_, col) => col === 0 ? textCell(col, index, value, style) : emptyCell(col, index, remainderStyle)));
}

function metadataRow(index, height, value, count) {
  // Frame the merged row as one field, without vertical rules inside it.
  return rowXml(index, height, Array.from({length: count}, (_, col) => col === 0 ? textCell(col, index, value, 12) : emptyCell(col, index, col === count - 1 ? 14 : 13)));
}

function columnsXml(count, widths) {
  return `<cols>${Array.from({length: count}, (_, index) => `<col min="${index + 1}" max="${index + 1}" width="${widths?.[index] ?? (index === 0 ? 7.52734375 : index < 3 ? 27.96875 : 21.02734375)}" customWidth="1"/>`).join('')}</cols>`;
}

function sheetXml(count, lastRow, rows, merges, widths) {
  return `${XML}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><dimension ref="A1:${column(count - 1)}${lastRow}"/><sheetViews><sheetView showGridLines="1" zoomScale="100" zoomScaleNormal="100" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>${columnsXml(count, widths)}<sheetData>${rows.join('')}</sheetData><mergeCells count="${merges.length}">${merges.map(ref => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells><pageMargins left="0" right="0" top="0" bottom="0" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape"/></worksheet>`;
}

function compactPeriod(period) {
  return String(period ?? '').replace(/-/g, '');
}

function balanceSheet(options) {
  const {companyName = '', startPeriod = '', endPeriod = startPeriod, levelFrom = 1, levelTo = 6, showActivityZero = false, ytd = false, scope = '', basis = '', hasProjection = false, rows = [], detailRows = []} = options;
  const groups = ['期初余额', scope === 'all' ? '累计发生额' : '本期发生额', ...(ytd ? ['本年累计'] : []), '期末余额'];
  const count = 3 + groups.length * 2;
  const lastColumn = column(count - 1);
  const output = [
    mergedRow(1, 19.5, scope === 'all' ? '余额总表' : '余额表', count, 1, 2),
    metadataRow(2, 19.5, `账套名称:${companyName}   `, count),
    metadataRow(3, 20.25, `期间:${compactPeriod(startPeriod)}至${compactPeriod(endPeriod)}${scope === 'all' ? '（全账套）' : ''}   科目级次:${levelFrom}级至${levelTo}级   单位:元   显示有发生无余额科目:${showActivityZero ? '是' : '否'}${basis === 'standard' ? `   损益结转口径${hasProjection ? '；含未结转测算' : ''}` : ''}   `, count),
  ];
  const merges = [`A1:${lastColumn}1`, `A2:${lastColumn}2`, `A3:${lastColumn}3`, 'A4:A5', 'B4:B5', 'C4:C5'];
  const top = ['序号', '科目编码', '科目'].map((value, index) => textCell(index, 4, value, 6));
  const bottom = [0, 1, 2].map(index => emptyCell(index, 5, 7));
  groups.forEach((label, index) => {
    const first = 3 + index * 2;
    top.push(textCell(first, 4, label, 6), emptyCell(first + 1, 4, 7));
    bottom.push(textCell(first, 5, '借方金额', 6), textCell(first + 1, 5, '贷方金额', 6));
    merges.push(`${column(first)}4:${column(first + 1)}4`);
  });
  output.push(rowXml(4, 15.75, top), rowXml(5, 15.75, bottom));
  const detailsByRow = groupDetails(rows, detailRows);
  let nextRow = 6;
  const appendDetails = details => {
    for (const detail of details ?? []) output.push(detailRowXml(nextRow++, detail, ytd));
  };
  // A restricted level range can hide every ancestor. Keep those payments
  // visible with their actual account metadata instead of dropping them.
  appendDetails(detailsByRow.get(-1));
  rows.forEach((item, index) => {
    const row = nextRow++;
    const level = Number.isFinite(Number(item.level)) ? Math.max(1, Math.min(100, Math.floor(Number(item.level)))) : 1;
    const indentation = item.code ? '  '.repeat(level - 1) : '';
    const nameUnits = Array.from(String(item.name ?? '')).reduce((size, character) => size + (character.codePointAt(0) >= 0x2E80 ? 2 : 1), 0) + indentation.length;
    const wrapName = Boolean(item.isCategory) || nameUnits > 26;
    const cells = [textCell(0, row, String(index + 1), 8), textCell(1, row, scope === 'all' ? String(item.code ?? '') : `${indentation}${item.code ?? ''}`, 9), textCell(2, row, `${indentation}${item.name ?? ''}`, wrapName ? 11 : 9)];
    for (let offset = 0; offset < groups.length * 2; offset += 1) cells.push(numericCell(3 + offset, row, item.amounts?.[offset]));
    const height = wrapName ? Math.min(409.5, Math.max(13.5, Math.ceil(nameUnits / 26) * 15 + 4)) : 13.5;
    output.push(rowXml(row, height, cells));
    appendDetails(detailsByRow.get(index));
  });
  return sheetXml(count, nextRow - 1, output, merges);
}

function groupDetails(rows, details) {
  const result = new Map();
  for (const detail of details) {
    const code = String(detail.account_code ?? '').trim();
    let target = -1;
    let longest = 0;
    rows.forEach((row, index) => {
      const candidate = String(row.code ?? '').trim();
      if (candidate && code.startsWith(candidate) && candidate.length > longest) {
        target = index;
        longest = candidate.length;
      }
    });
    if (!result.has(target)) result.set(target, []);
    result.get(target).push(detail);
  }
  return result;
}

export function balanceDetailLabel(detail = {}) {
  const company = String(detail.counterparty ?? '').trim() || '未提供对方名称';
  const summary = [detail.summary, detail.line_summary, detail.description]
    .map(value => String(value ?? '').trim()).find(Boolean) || '';
  const expense = summary.replace(/^转取\s*[:：]?\s*/, '').trim() || '未提供费用名称';
  return {company, expense};
}

function detailRowXml(row, detail, ytd) {
  const {company, expense} = balanceDetailLabel(detail);
  const metadata = ['', company, expense];
  const fields = ['opening_debit_fen', 'opening_credit_fen', 'debit_fen', 'credit_fen', ...(ytd ? ['ytd_debit_fen', 'ytd_credit_fen'] : []), 'closing_debit_fen', 'closing_credit_fen'];
  const cells = metadata.map((value, col) => textCell(col, row, value, 11));
  fields.forEach((field, offset) => {
    const amount = detail[field] ?? 0;
    if (!Number.isSafeInteger(amount)) throw new TypeError(`Invalid integer fen amount: ${field}`);
    cells.push(numericCell(3 + offset, row, amount / 100));
  });
  // Preserve the template widths. Estimate wrapped lines using full-width
  // Chinese characters as two Latin characters, including explicit newlines.
  const lines = (value, width) => String(value).split(/\r\n|\r|\n/).reduce((total, line) => {
    const units = Array.from(line).reduce((size, character) => size + (character.codePointAt(0) >= 0x2E80 ? 2 : 1), 0);
    return total + Math.max(1, Math.ceil(units / width));
  }, 0);
  const lineCount = Math.max(...metadata.map((value, col) => lines(value, col === 0 ? 7 : 26)));
  return rowXml(row, Math.min(409.5, Math.max(42, lineCount * 13.5 + 6)), cells);
}

function stylesXml() {
  const alignment = (horizontal, wrap = false) => `<alignment horizontal="${horizontal}" vertical="center" textRotation="0" wrapText="${wrap ? 1 : 0}" shrinkToFit="0"/>`;
  const xf = (fontId, borderId, numFmtId, horizontal, wrap = false) => `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="2" borderId="${borderId}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${alignment(horizontal, wrap)}</xf>`;
  const side = name => `<${name} style="thin"><color rgb="FF000000"/></${name}>`;
  return `${XML}<styleSheet xmlns="${MAIN_NS}"><numFmts count="2"><numFmt numFmtId="166" formatCode="@"/><numFmt numFmtId="167" formatCode="#,##0.00_ ;-#,##0.00;;"/></numFmts><fonts count="3"><font><sz val="10"/><color rgb="FF000000"/><name val="宋体"/><charset val="134"/></font><font><b/><sz val="15"/><color rgb="FF000000"/><name val="黑体"/><charset val="134"/></font><font><b/><sz val="12"/><color rgb="FF000000"/><name val="黑体"/><charset val="134"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/><bgColor rgb="FFFFFFFF"/></patternFill></fill></fills><borders count="6"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/>${side('bottom')}<diagonal/></border><border>${['left', 'right', 'top', 'bottom'].map(side).join('')}<diagonal/></border><border>${side('left')}<right/>${side('top')}${side('bottom')}<diagonal/></border><border><left/><right/>${side('top')}${side('bottom')}<diagonal/></border><border><left/>${side('right')}${side('top')}${side('bottom')}<diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellStyleXfs><cellXfs count="16"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>${[
    xf(1, 0, 0, 'center'), // 1: title
    xf(0, 0, 0, 'general'), // 2: merged title remainder
    xf(0, 0, 0, 'left', true), // 3: company
    xf(0, 1, 0, 'left', true), // 4: report criteria
    xf(0, 1, 0, 'general'), // 5: criteria merged remainder
    xf(2, 2, 0, 'center'), // 6: heading
    xf(0, 2, 0, 'general'), // 7: merged heading remainder
    xf(0, 2, 166, 'center'), // 8: sequence as text
    xf(0, 2, 166, 'left'), // 9: account code and name
    xf(0, 2, 167, 'right'), // 10: typed currency amount
    xf(0, 2, 166, 'left', true), // 11: inline payment metadata
    xf(0, 3, 0, 'left', true), // 12: merged metadata left edge
    xf(0, 4, 0, 'general'), // 13: merged metadata top and bottom
    xf(0, 5, 0, 'general'), // 14: merged metadata right edge
    xf(2, 2, 0, 'center', true), // 15: wrapped heading
  ].join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xEDB88320 ^ (crc >>> 1) : crc >>> 1;
  crcTable[index] = crc >>> 0;
}

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// XLSX is an OPC ZIP archive. Store entries keep the exporter small and offline.
function zip(files) {
  const entries = files.map(([name, content]) => {
    const filename = encoder.encode(name);
    const data = encoder.encode(content);
    return {filename, data, crc: crc32(data), offset: 0};
  });
  const localSize = entries.reduce((size, entry) => size + 30 + entry.filename.length + entry.data.length, 0);
  const centralSize = entries.reduce((size, entry) => size + 46 + entry.filename.length, 0);
  const totalSize = localSize + centralSize + 22;
  if (totalSize > 0xFFFFFFFF) throw new RangeError('Workbook exceeds ZIP size limit');
  const bytes = new Uint8Array(totalSize);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  const u16 = value => { view.setUint16(offset, value, true); offset += 2; };
  const u32 = value => { view.setUint32(offset, value >>> 0, true); offset += 4; };
  const append = value => { bytes.set(value, offset); offset += value.length; };
  for (const entry of entries) {
    entry.offset = offset;
    u32(0x04034B50); u16(20); u16(0x0800); u16(0); u16(0); u16(33);
    u32(entry.crc); u32(entry.data.length); u32(entry.data.length); u16(entry.filename.length); u16(0);
    append(entry.filename); append(entry.data);
  }
  const centralOffset = offset;
  for (const entry of entries) {
    u32(0x02014B50); u16(20); u16(20); u16(0x0800); u16(0); u16(0); u16(33);
    u32(entry.crc); u32(entry.data.length); u32(entry.data.length); u16(entry.filename.length);
    u16(0); u16(0); u16(0); u16(0); u32(0); u32(entry.offset); append(entry.filename);
  }
  u32(0x06054B50); u16(0); u16(0); u16(entries.length); u16(entries.length);
  u32(centralSize); u32(centralOffset); u16(0);
  return bytes;
}

/**
 * Create a real .xlsx file from a supplied balance report.
 * rows: {code, name, level, amounts[]} with amounts in yuan.
 * amounts: opening debit/credit, period debit/credit, optional YTD debit/credit,
 * then closing debit/credit. Subtotals and totals are supplied by the caller.
 * detailRows: {date, account_code, account_name, counterparty, summary,
 * source_label, reference, period_bucket, opening_debit_fen, opening_credit_fen,
 * debit_fen, credit_fen, closing_debit_fen, closing_credit_fen, ytd_debit_fen,
 * ytd_credit_fen}[] with optional date_source_label and integer fen amounts.
 * Each detail follows its account or closest visible ancestor. Details explain
 * supplied balance rows and never change caller-supplied subtotals or totals.
 */
export function createBalanceXlsx(options = {}) {
  if (!Array.isArray(options.rows ?? [])) throw new TypeError('rows must be an array');
  const detailRows = options.detailRows ?? [];
  if (!Array.isArray(detailRows)) throw new TypeError('detailRows must be an array');
  if (detailRows.some(detail => !detail || typeof detail !== 'object' || Array.isArray(detail))) throw new TypeError('detailRows must contain objects');
  const sheetNames = ['Sheet1'];
  const files = [
    ['[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetNames.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`],
    ['_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL_NS}/extended-properties" Target="docProps/app.xml"/></Relationships>`],
    ['docProps/core.xml', `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${options.scope === 'all' ? '余额总表' : '余额表'}</dc:title><dc:creator>财务工作台</dc:creator></cp:coreProperties>`],
    ['docProps/app.xml', `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>财务工作台</Application><TitlesOfParts><vt:vector size="${sheetNames.length}" baseType="lpstr">${sheetNames.map(name => `<vt:lpstr>${xml(name)}</vt:lpstr>`).join('')}</vt:vector></TitlesOfParts></Properties>`],
    ['xl/workbook.xml', `${XML}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheetNames.map((name, index) => `<sheet name="${xml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetNames.map((_, index) => `<Relationship Id="rId${index + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="rId${sheetNames.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', stylesXml()],
    ['xl/worksheets/sheet1.xml', balanceSheet({...options, detailRows})],
  ];
  return zip(files);
}
