/* Browser-only workbook for 会小企01 / 会小企02. Amounts are integer fen. */
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const encoder = new TextEncoder();

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

function yuanText(fen) {
  const amount = Number(fen);
  if (!Number.isSafeInteger(amount)) throw new TypeError('报表金额必须是整数分');
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function moneyCell(col, row, fen) {
  if (fen === null || fen === undefined || fen === '') return emptyCell(col, row, 5);
  return `<c r="${column(col)}${row}" s="5"><v>${yuanText(fen)}</v></c>`;
}

function rowXml(index, height, cells) {
  return `<row r="${index}" ht="${height}" customHeight="1">${cells.join('')}</row>`;
}

function sheetXml(count, widths, rows, merges, landscape) {
  const lastRow = rows.length ? rows.length : 1;
  return `${XML}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><dimension ref="A1:${column(count - 1)}${lastRow}"/><sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>${`<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>`}<sheetData>${rows.join('')}</sheetData><mergeCells count="${merges.length}">${merges.map(ref => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells><pageMargins left="0.4" right="0.4" top="0.5" bottom="0.4" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="${landscape ? 'landscape' : 'portrait'}"/></worksheet>`;
}

function stylesXml() {
  const alignment = (horizontal, wrap = false) => `<alignment horizontal="${horizontal}" vertical="center" wrapText="${wrap ? 1 : 0}"/>`;
  const side = name => `<${name} style="thin"><color rgb="FF000000"/></${name}>`;
  const xf = (fontId, borderId, numFmtId, horizontal) => `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="0" borderId="${borderId}" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1">${alignment(horizontal)}</xf>`;
  return `${XML}<styleSheet xmlns="${MAIN_NS}"><numFmts count="1"><numFmt numFmtId="166" formatCode="#,##0.00"/></numFmts><fonts count="3"><font><sz val="10"/><color rgb="FF000000"/><name val="宋体"/><charset val="134"/></font><font><sz val="16"/><color rgb="FF000000"/><name val="宋体"/><charset val="134"/></font><font><b/><sz val="10"/><color rgb="FF000000"/><name val="宋体"/><charset val="134"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border>${['left', 'right', 'top', 'bottom'].map(side).join('')}<diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellStyleXfs><cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>${[
    xf(1, 0, 0, 'center'),
    xf(0, 0, 0, 'left'),
    xf(0, 0, 0, 'right'),
    xf(2, 1, 0, 'center'),
    xf(0, 1, 166, 'right'),
    xf(0, 1, 0, 'center'),
    xf(0, 1, 0, 'left'),
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

function zip(files) {
  const entries = files.map(([name, content]) => ({filename: encoder.encode(name), data: encoder.encode(content), crc: 0, offset: 0}));
  for (const entry of entries) entry.crc = crc32(entry.data);
  const localSize = entries.reduce((size, entry) => size + 30 + entry.filename.length + entry.data.length, 0);
  const centralSize = entries.reduce((size, entry) => size + 46 + entry.filename.length, 0);
  const bytes = new Uint8Array(localSize + centralSize + 22);
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

function workbook(sheetName, sheet, title) {
  const safeName = xml(String(sheetName || 'Sheet1').slice(0, 31));
  return zip([
    ['[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`],
    ['_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL_NS}/extended-properties" Target="docProps/app.xml"/></Relationships>`],
    ['docProps/core.xml', `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(title)}</dc:title><dc:creator>财务工作台</dc:creator></cp:coreProperties>`],
    ['docProps/app.xml', `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>财务工作台</Application></Properties>`],
    ['xl/workbook.xml', `${XML}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="${safeName}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', stylesXml()],
    ['xl/worksheets/sheet1.xml', sheet],
  ]);
}

function lineCell(col, row, value) {
  return value ? textCell(col, row, value, 6) : emptyCell(col, row, 6);
}

export function createStatutoryBalanceXlsx(statement = {}) {
  const report = statement.balance_sheet || {};
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const count = 8;
  const output = [
    rowXml(1, 24, [textCell(0, 1, report.title || '资产负债表', 1), ...Array.from({length: 7}, (_, index) => emptyCell(index + 1, 1, 1))]),
    rowXml(2, 18, [textCell(0, 2, `编制单位：${statement.company || ''}`, 2), emptyCell(1, 2, 2), emptyCell(2, 2, 2), emptyCell(3, 2, 2), emptyCell(4, 2, 2), emptyCell(5, 2, 2), emptyCell(6, 2, 2), textCell(7, 2, report.form_no || '', 3)]),
    rowXml(3, 18, [emptyCell(0, 3, 2), emptyCell(1, 3, 2), emptyCell(2, 3, 2), textCell(3, 3, statement.date || '', 1), emptyCell(4, 3, 2), emptyCell(5, 3, 2), emptyCell(6, 3, 2), textCell(7, 3, '单位：元', 3)]),
    rowXml(4, 18, ['资产', '行次', '期末余额', '年初余额', '负债和所有者权益', '行次', '期末余额', '年初余额'].map((value, index) => textCell(index, 4, value, 4))),
  ];
  rows.forEach((item, index) => {
    const row = index + 5;
    output.push(rowXml(row, 16, [
      textCell(0, row, item.asset_name || '', 7),
      lineCell(1, row, item.asset_line),
      moneyCell(2, row, item.asset_ending_fen),
      moneyCell(3, row, item.asset_begin_fen),
      textCell(4, row, item.equity_name || '', 7),
      lineCell(5, row, item.equity_line),
      moneyCell(6, row, item.equity_ending_fen),
      moneyCell(7, row, item.equity_begin_fen),
    ]));
  });
  const sheet = sheetXml(count, [28, 8, 14, 14, 36, 8, 14, 14], output, ['A1:H1', 'A2:E2', 'D3:E3'], true);
  return workbook(`${statement.company || ''}_资产负债表_${String(statement.period || '').replace('-', '')}`, sheet, '资产负债表');
}

export function createStatutoryProfitXlsx(statement = {}) {
  const report = statement.profit || {};
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const output = [
    rowXml(1, 24, [textCell(0, 1, report.title || '利润表', 1), emptyCell(1, 1, 1), emptyCell(2, 1, 1), emptyCell(3, 1, 1)]),
    rowXml(2, 18, [textCell(0, 2, `编制单位：${statement.company || ''}`, 2), emptyCell(1, 2, 2), emptyCell(2, 2, 2), textCell(3, 2, report.form_no || '', 3)]),
    rowXml(3, 18, [emptyCell(0, 3, 2), emptyCell(1, 3, 2), textCell(2, 3, statement.period || '', 1), textCell(3, 3, '单位：元', 3)]),
    rowXml(4, 18, ['项目', '行次', '本月金额', '本年累计金额'].map((value, index) => textCell(index, 4, value, 4))),
  ];
  rows.forEach((item, index) => {
    const row = index + 5;
    output.push(rowXml(row, 16, [
      textCell(0, row, item.name || '', 7),
      lineCell(1, row, item.line),
      moneyCell(2, row, item.month_fen),
      moneyCell(3, row, item.ytd_fen),
    ]));
  });
  const sheet = sheetXml(4, [42, 8, 16, 16], output, ['A1:D1', 'A2:C2'], false);
  return workbook(`${statement.company || ''}_利润表_${String(statement.period || '').replace('-', '')}`, sheet, '利润表');
}
