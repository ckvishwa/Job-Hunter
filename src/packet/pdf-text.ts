import { readFileSync } from "node:fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { flattenPdfText } from "../pipeline/resume-plan.js";

/** Text of every page of a PDF, exactly as the renderer's own integrity check reads it. */
export async function extractPdfText(filePath: string): Promise<{ text: string; pageCount: number }> {
  const pdf = await getDocument({ data: new Uint8Array(readFileSync(filePath)), useSystemFonts: true }).promise;
  const pages: string[] = [];
  try {
    for (let n = 1; n <= pdf.numPages; n += 1) {
      const content = await (await pdf.getPage(n)).getTextContent();
      pages.push(flattenPdfText(content.items as Array<{ str?: string; hasEOL?: boolean }>));
    }
    return { text: pages.join(" "), pageCount: pdf.numPages };
  } finally {
    await pdf.cleanup();
  }
}
