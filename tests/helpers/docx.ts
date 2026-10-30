import { deflateRawSync } from "node:zlib";

// Minimal .docx writer for tests: a zip with one DEFLATE-compressed word/document.xml (plus a [Content_Types].xml).
// Each paragraph is a list of runs; a run is text, or "\t" for a tab element. Includes <w:tabs>/<w:tab> property
// elements in the paragraph properties, which a careless `<w:t` regex would mistake for text.

const CRC_TABLE = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const xmlEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function paragraphXml(text: string): string {
  const props = '<w:pPr><w:tabs><w:tab w:val="right" w:pos="10512"/></w:tabs><w:spacing w:after="20"/></w:pPr>';
  const runs = text
    .split("\t")
    .flatMap((part, i) => (i === 0 ? [part] : ["\t", part]))
    .filter((part) => part !== "")
    .map((part) => (part === "\t" ? "<w:r><w:tab/></w:r>" : `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${xmlEscape(part)}</w:t></w:r>`))
    .join("");
  return `<w:p>${props}${runs}</w:p>`;
}

export function buildDocx(paragraphs: string[]): Buffer {
  const files: { name: string; data: Buffer }[] = [
    { name: "[Content_Types].xml", data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>') },
    {
      name: "word/document.xml",
      data: Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(paragraphXml).join("")}</w:body></w:document>`),
    },
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const compressed = deflateRawSync(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc32(f.data), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(f.data), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}
